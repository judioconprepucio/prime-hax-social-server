import { closePool, getPool } from '../db.js';

const client = await getPool().connect();
try {
  await client.query('BEGIN');
  const suffix = Date.now().toString(36).slice(-8);
  const users = await client.query(
    `INSERT INTO users (handle, handle_display, password_hash, display_name)
     VALUES ($1, $2, $3, 'Chat Smoke A'), ($4, $5, $3, 'Chat Smoke B')
     RETURNING id`,
    [`smokea${suffix}`, `SmokeA${suffix}`, 'x'.repeat(32), `smokeb${suffix}`, `SmokeB${suffix}`]
  );
  const [first, second] = users.rows;
  await client.query(
    `INSERT INTO friendships (user_low_id, user_high_id, requested_by, status, responded_at)
     VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $1, 'accepted', now())`,
    [first.id, second.id]
  );
  const conversation = await client.query(
    `INSERT INTO conversations (kind, direct_user_low_id, direct_user_high_id)
     VALUES ('direct', LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))
     RETURNING id`,
    [first.id, second.id]
  );
  await client.query(
    `INSERT INTO conversation_members (conversation_id, user_id)
     VALUES ($1, $2), ($1, $3)`,
    [conversation.rows[0].id, first.id, second.id]
  );
  await client.query(
    `INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1, $2, 'mensaje de prueba')`,
    [conversation.rows[0].id, first.id]
  );
  await client.query(
    `INSERT INTO room_invites (sender_id, receiver_id, room_url, room_name, expires_at)
     VALUES ($1, $2, 'https://www.haxball.com/play?c=smoke', 'Smoke room', now() + interval '15 minutes')`,
    [first.id, second.id]
  );
  const verified = await client.query(
    `SELECT
       (SELECT count(*)::int FROM messages WHERE conversation_id = $1) AS messages,
       (SELECT count(*)::int FROM room_invites WHERE sender_id = $2 AND receiver_id = $3) AS invites`,
    [conversation.rows[0].id, first.id, second.id]
  );
  if (verified.rows[0].messages !== 1 || verified.rows[0].invites !== 1) {
    throw new Error('No se pudo verificar el circuito social');
  }
  process.stdout.write('CHAT_DATABASE_OK (transaction rolled back)\n');
} finally {
  await client.query('ROLLBACK').catch(() => undefined);
  client.release();
  await closePool();
}
