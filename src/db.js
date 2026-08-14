import pg from 'pg';
import { databaseConfig } from './config.js';

const { Pool } = pg;
let pool;

export function getPool() {
  if (!pool) pool = new Pool(databaseConfig());
  return pool;
}

export async function withTransaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}
