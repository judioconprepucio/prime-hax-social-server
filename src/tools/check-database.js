import { closePool, getPool } from '../db.js';

const expectedTables = [
  'users',
  'invitation_codes',
  'trusted_devices',
  'friendships',
  'followers',
  'profile_media',
  'user_blocks',
  'conversations',
  'conversation_members',
  'messages',
  'room_invites'
];

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
          'friendships',
          'followers',
          'profile_media',
          'user_blocks',
          'conversations',
          'conversation_members',
          'messages',
          'room_invites',
          'refresh_sessions'
        )
    ) AS core_tables,
    ARRAY(
      SELECT table_name::text
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name
    ) AS available_tables,
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
  const result = await getPool().query(query, [[...expectedTables, 'refresh_sessions']]);
  const status = result.rows[0];
  const missingTables = [...expectedTables, 'refresh_sessions']
    .filter((table) => !status.available_tables.includes(table));
  if (status.core_tables !== 12 || missingTables.length || !status.device_migration) {
    throw new Error(`La base no contiene toda la estructura esperada. Faltan: ${missingTables.join(', ') || 'columnas de migracion'}`);
  }
  process.stdout.write(`DATABASE_OK (${status.database_name})\n`);
  process.stdout.write(`CORE_TABLES_OK (${status.core_tables}/12)\n`);
  process.stdout.write('DEVICE_MIGRATION_OK\n');
} finally {
  await closePool();
}
