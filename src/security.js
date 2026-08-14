import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature
} from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { securityConfig } from './config.js';

export function normalizeHandle(value) {
  return String(value ?? '').trim().replace(/^@/, '').toLowerCase();
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function hashWithPepper(value, pepper) {
  return createHmac('sha256', pepper).update(String(value)).digest('hex');
}

export function hashNonce(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function safeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function validateDevicePublicKey(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('La clave del dispositivo debe ser Ed25519');
  }
  const der = key.export({ type: 'spki', format: 'der' });
  return {
    key,
    fingerprint: createHash('sha256').update(der).digest('hex')
  };
}

export function verifyDeviceSignature(publicKeyPem, nonce, signature) {
  try {
    const { key } = validateDevicePublicKey(publicKeyPem);
    return verifySignature(
      null,
      Buffer.from(nonce, 'utf8'),
      key,
      Buffer.from(signature, 'base64url')
    );
  } catch {
    return false;
  }
}

export async function createAccessToken(userId, deviceId) {
  const config = securityConfig();
  const key = new TextEncoder().encode(config.jwtSecret);
  return new SignJWT({ device_id: deviceId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer('prime-hax-social')
    .setAudience('prime-hax-client')
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenMinutes}m`)
    .sign(key);
}

export async function verifyAccessToken(token) {
  const config = securityConfig();
  const key = new TextEncoder().encode(config.jwtSecret);
  const { payload } = await jwtVerify(token, key, {
    issuer: 'prime-hax-social',
    audience: 'prime-hax-client',
    algorithms: ['HS256']
  });
  if (!payload.sub || typeof payload.device_id !== 'string') {
    throw new Error('invalid_access_token');
  }
  return { userId: payload.sub, deviceId: payload.device_id };
}
