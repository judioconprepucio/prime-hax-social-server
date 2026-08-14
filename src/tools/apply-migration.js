import fs from 'node:fs/promises';
import path from 'node:path';
import { closePool, getPool } from '../db.js';

const migrationName = process.argv[2];
if (!migrationName || !/^\d{3}_[a-z0-9_-]+\.sql$/i.test(migrationName)) {
  throw new Error('Uso: node src/tools/apply-migration.js 003_private_roles.sql');
}

const migrationPath = path.resolve('database', 'migrations', migrationName);
const sql = await fs.readFile(migrationPath, 'utf8');
const client = await getPool().connect();

try {
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
  process.stdout.write(`MIGRATION_OK (${migrationName})\n`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await closePool();
}
