import 'dotenv/config';
import argon2 from 'argon2';
import { closePool, getPool } from '../db.js';
import { normalizeHandle } from '../security.js';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readSecret(label) {
  if (!process.stdin.isTTY) throw new Error('Ejecuta este comando desde una terminal interactiva.');
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    const finish = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          reject(new Error('Operacion cancelada.'));
          return;
        }
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\u007f' || character === '\b') {
          if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        value += character;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

const handle = normalizeHandle(argument('handle') || '');
if (!handle) throw new Error('Uso: npm run password:reset -- --handle NombreJugador');

try {
  const first = await readSecret('Nueva contraseña (mínimo 12 caracteres): ');
  const second = await readSecret('Repetir nueva contraseña: ');
  if (first.length < 12 || first.length > 128) throw new Error('La contraseña debe tener entre 12 y 128 caracteres.');
  if (first !== second) throw new Error('Las contraseñas no coinciden.');

  const passwordHash = await argon2.hash(first, {
    type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1
  });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const user = await client.query(
      `UPDATE users SET password_hash = $2, updated_at = now()
        WHERE handle = $1 AND is_disabled = false
        RETURNING id, handle_display`,
      [handle, passwordHash]
    );
    if (!user.rowCount) throw new Error('No existe una cuenta activa con ese usuario.');
    await client.query(
      `UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, now())
        WHERE user_id = $1`,
      [user.rows[0].id]
    );
    await client.query(
      `INSERT INTO security_audit_events (user_id, event_type)
       VALUES ($1, 'password_reset_local_admin')`,
      [user.rows[0].id]
    );
    await client.query('COMMIT');
    console.log(`Contraseña actualizada para @${user.rows[0].handle_display}. El dispositivo continúa vinculado.`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
} finally {
  await closePool();
}
