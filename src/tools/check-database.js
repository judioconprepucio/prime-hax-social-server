import { closePool, getPool } from '../db.js';

const query = `
  SELECT
    (
      SELECT count(*)::int
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'users',
          'invitation_codes',
          'trusted_devices',
          'messages',
          'room_invites'
        )
    ) AS core_tables,
    EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'refresh_sessions'
        AND column_name = 'device_id'
    ) AS device_migration,
    current_database() AS database_name
`;

try {
  const result = await getPool().query(query);
  const status = result.rows[0];
  if (status.core_tables !== 5 || !status.device_migration) {
    throw new Error('La base no contiene toda la estructura esperada');
  }
  process.stdout.write(`DATABASE_OK (${status.database_name})\n`);
  process.stdout.write(`CORE_TABLES_OK (${status.core_tables}/5)\n`);
  process.stdout.write('DEVICE_MIGRATION_OK\n');
} finally {
  await closePool();
}
