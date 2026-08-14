import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import {
  hashNonce,
  normalizeHandle,
  safeHexEqual,
  validateDevicePublicKey,
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
