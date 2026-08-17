import assert from 'node:assert/strict';
import test from 'node:test';
import { canManageMusicCatalog, safeAudioFilename } from '../src/music-utils.js';

test('solo desarrolladores y administradores gestionan el catálogo musical', () => {
  assert.equal(canManageMusicCatalog('member'), false);
  assert.equal(canManageMusicCatalog('helper'), false);
  assert.equal(canManageMusicCatalog('developer'), true);
  assert.equal(canManageMusicCatalog('admin'), true);
});

test('normaliza nombres de audio sin permitir rutas ni extensiones arbitrarias', () => {
  assert.equal(safeAudioFilename('../Música de Prueba.MP3'), 'Musica-de-Prueba.mp3');
  assert.equal(safeAudioFilename('folder\\tema final.flac'), 'tema-final.flac');
  assert.equal(safeAudioFilename('archivo.exe'), null);
  assert.equal(safeAudioFilename('sin-extension'), null);
});
