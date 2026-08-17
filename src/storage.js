import { createClient } from '@supabase/supabase-js';
import { storageConfig } from './config.js';

let client;
let config;

export function getStorageConfig() {
  if (!config) config = storageConfig();
  return config;
}

export function getStorageClient() {
  if (!client) {
    const current = getStorageConfig();
    client = createClient(current.url, current.secretKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false
      }
    });
  }
  return client;
}

export function getMusicBucket() {
  const current = getStorageConfig();
  return getStorageClient().storage.from(current.musicBucket);
}
