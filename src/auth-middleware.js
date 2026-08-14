import { getPool } from './db.js';
import { verifyAccessToken } from './security.js';

export async function requireAuth(request, reply) {
  const authorization = String(request.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return reply.code(401).send({ error: 'authentication_required' });

  try {
    const auth = await verifyAccessToken(match[1]);
    const result = await getPool().query(
      `SELECT u.id
       FROM users u
       JOIN trusted_devices d ON d.id = $2 AND d.user_id = u.id
       WHERE u.id = $1 AND u.is_disabled = false AND d.revoked_at IS NULL`,
      [auth.userId, auth.deviceId]
    );
    if (!result.rowCount) return reply.code(401).send({ error: 'invalid_session' });
    request.auth = auth;
  } catch {
    return reply.code(401).send({ error: 'invalid_session' });
  }
}
