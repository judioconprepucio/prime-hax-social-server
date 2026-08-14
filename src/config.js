import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

function requiredSecret(name, minimumLength = 32) {
  const value = process.env[name];
  if (!value || value.length < minimumLength) {
    throw new Error(`${name} debe contener al menos ${minimumLength} caracteres`);
  }
  return value;
}

function positiveInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} debe ser un entero positivo`);
  }
  return value;
}

export function databaseConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL no está configurada');

  const sslMode = process.env.DATABASE_SSL || 'verify-full';
  let ssl = false;
  if (sslMode !== 'disable') {
    const certificatePath = process.env.DATABASE_CA_CERT_PATH;
    if (!certificatePath) {
      throw new Error('DATABASE_CA_CERT_PATH no está configurada');
    }
    const resolvedCertificatePath = path.resolve(certificatePath);
    if (!fs.existsSync(resolvedCertificatePath)) {
      throw new Error(`No se encontró el certificado de Supabase en ${resolvedCertificatePath}`);
    }
    ssl = {
      rejectUnauthorized: true,
      ca: fs.readFileSync(resolvedCertificatePath, 'utf8')
    };
  }

  return {
    connectionString,
    ssl,
    max: positiveInteger('DATABASE_POOL_SIZE', 5),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000
  };
}

export function securityConfig() {
  return {
    jwtSecret: requiredSecret('JWT_ACCESS_SECRET'),
    refreshPepper: requiredSecret('REFRESH_TOKEN_PEPPER'),
    invitePepper: requiredSecret('INVITE_CODE_PEPPER'),
    recoveryPepper: requiredSecret('RECOVERY_CODE_PEPPER'),
    accessTokenMinutes: positiveInteger('ACCESS_TOKEN_MINUTES', 15),
    refreshTokenDays: positiveInteger('REFRESH_TOKEN_DAYS', 30)
  };
}

export function serverConfig() {
  return {
    host: process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1'),
    port: positiveInteger('PORT', 3000),
    production: process.env.NODE_ENV === 'production'
  };
}
