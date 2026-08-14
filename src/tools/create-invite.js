import { getPool, closePool } from '../db.js';
import { securityConfig } from '../config.js';
import { hashWithPepper, normalizeHandle, randomToken } from '../security.js';
import fs from 'node:fs/promises';
import path from 'node:path';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const handleValue = argument('handle');
const handle = handleValue ? normalizeHandle(handleValue) : null;
const label = argument('label') || (handle ? `Invitación para @${handle}` : 'Invitación privada');
const days = Number.parseInt(argument('days') || '7', 10);
const role = argument('role') || 'member';
const outputPath = argument('output');

if (handle && !/^[a-z0-9][a-z0-9_-]{2,23}$/.test(handle)) {
  throw new Error('El handle debe tener entre 3 y 24 caracteres válidos');
}
if (!Number.isInteger(days) || days < 1 || days > 30) {
  throw new Error('--days debe estar entre 1 y 30');
}
if (!['member', 'helper', 'developer', 'admin'].includes(role)) {
  throw new Error('--role debe ser member, helper, developer o admin');
}

const config = securityConfig();
const code = `PHX-I-${randomToken(18)}`;
const codeHash = hashWithPepper(code, config.invitePepper);
const expiresAt = new Date(Date.now() + days * 86_400_000);

try {
  await getPool().query(
    `INSERT INTO invitation_codes (code_hash, intended_handle, label, granted_role, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [codeHash, handle, label, role, expiresAt]
  );
  const inviteText = [
    `Codigo: ${code}`,
    `Handle canonico: ${handle ? `@${handle}` : 'cualquiera autorizado'}`,
    `Rol: ${role}`,
    `Vence: ${expiresAt.toISOString()}`,
    ''
  ].join('\n');

  if (outputPath) {
    const resolvedOutputPath = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await fs.writeFile(resolvedOutputPath, inviteText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    process.stdout.write(`Invitacion guardada en ${resolvedOutputPath}\n`);
  } else {
    process.stdout.write(`\nCódigo (se muestra una sola vez): ${code}\n`);
  }
  process.stdout.write(`Handle: ${handle ? `@${handle}` : 'cualquiera autorizado'}\n`);
  process.stdout.write(`Rol: ${role}\n`);
  process.stdout.write(`Vence: ${expiresAt.toISOString()}\n\n`);
} finally {
  await closePool();
}
