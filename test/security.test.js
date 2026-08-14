import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import {
  createAccessToken,
  hashNonce,
  normalizeHandle,
  safeHexEqual,
  validateDevicePublicKey,
  verifyAccessToken,
  verifyDeviceSignature
} from '../src/security.js';

test('normaliza handles sin conservar el prefijo visible', () => {
  assert.equal(normalizeHandle('  @Jugador_01 '), 'jugador_01');
});

test('compara hashes válidos sin conversión insegura', () => {
  const hash = hashNonce('nonce-de-prueba');
  assert.equal(safeHexEqual(hash, hash), true);
  assert.equal(safeHexEqual(hash, hashNonce('otro-nonce')), false);
  assert.equal(safeHexEqual('invalido', hash), false);
});

test('valida una firma Ed25519 del dispositivo', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const nonce = 'desafio-unico-del-servidor';
  const signature = sign(null, Buffer.from(nonce), privateKey).toString('base64url');

  const validated = validateDevicePublicKey(publicKeyPem);
  assert.match(validated.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(verifyDeviceSignature(publicKeyPem, nonce, signature), true);
  assert.equal(verifyDeviceSignature(publicKeyPem, `${nonce}-alterado`, signature), false);
});

test('crea y verifica un access token ligado al usuario y dispositivo', async () => {
  const names = [
    'JWT_ACCESS_SECRET',
    'REFRESH_TOKEN_PEPPER',
    'INVITE_CODE_PEPPER',
    'RECOVERY_CODE_PEPPER'
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.JWT_ACCESS_SECRET = 'j'.repeat(64);
  process.env.REFRESH_TOKEN_PEPPER = 'r'.repeat(64);
  process.env.INVITE_CODE_PEPPER = 'i'.repeat(64);
  process.env.RECOVERY_CODE_PEPPER = 'c'.repeat(64);
  try {
    const userId = '9c820eda-2c2c-4f39-b4e0-825597638503';
    const deviceId = '1cda15f9-7b79-4696-8e3c-cd866008ece0';
    const token = await createAccessToken(userId, deviceId);
    assert.deepEqual(await verifyAccessToken(token), { userId, deviceId });
    await assert.rejects(() => verifyAccessToken(`${token}alterado`));
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
