import { requireAuth } from '../auth-middleware.js';
import { getPool, withTransaction } from '../db.js';
import { normalizeHandle } from '../security.js';

function publicUser(row) {
  return {
    id: row.id,
    handle: `@${row.handle_display}`,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bannerUrl: row.banner_url,
    hasAvatarMedia: Boolean(row.avatar_media_updated_at),
    hasBannerMedia: Boolean(row.banner_media_updated_at),
    avatarMediaVersion: row.avatar_media_updated_at || null,
    bannerMediaVersion: row.banner_media_updated_at || null,
    bio: row.bio,
    presence: row.presence,
    lastSeenAt: row.last_seen_at,
    role: row.role
  };
}

async function findUserByHandle(handle) {
  const result = await getPool().query(
    `SELECT u.id, u.handle, u.handle_display, u.display_name, u.avatar_url, u.banner_url, u.bio, u.presence, u.last_seen_at, u.role,
            avatar.updated_at AS avatar_media_updated_at, banner.updated_at AS banner_media_updated_at
     FROM users u
     LEFT JOIN profile_media avatar ON avatar.user_id = u.id AND avatar.kind = 'avatar'
     LEFT JOIN profile_media banner ON banner.user_id = u.id AND banner.kind = 'banner'
     WHERE u.handle = $1 AND u.is_disabled = false`,
    [normalizeHandle(handle)]
  );
  return result.rows[0] || null;
}

const userIdParams = {
  type: 'object', additionalProperties: false, required: ['userId'],
  properties: { userId: { type: 'string', format: 'uuid' } }
};

export async function socialRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/me', async (request, reply) => {
    const result = await getPool().query(
      `SELECT u.id, u.handle, u.handle_display, u.display_name, u.avatar_url, u.banner_url, u.bio, u.presence, u.last_seen_at, u.role,
              avatar.updated_at AS avatar_media_updated_at, banner.updated_at AS banner_media_updated_at
       FROM users u
       LEFT JOIN profile_media avatar ON avatar.user_id = u.id AND avatar.kind = 'avatar'
       LEFT JOIN profile_media banner ON banner.user_id = u.id AND banner.kind = 'banner'
       WHERE u.id = $1 AND u.is_disabled = false`,
      [request.auth.userId]
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'user_not_found' });
    return { user: publicUser(result.rows[0]) };
  });

  app.patch('/me', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          displayName: { type: 'string', minLength: 1, maxLength: 40 },
          bio: { type: 'string', maxLength: 280 },
          avatarUrl: { anyOf: [
            { type: 'string', pattern: '^https://', maxLength: 500 },
            { type: 'null' }
          ] },
          bannerUrl: { anyOf: [
            { type: 'string', pattern: '^https://', maxLength: 500 },
            { type: 'null' }
          ] }
        }
      }
    }
  }, async (request) => {
    const current = await getPool().query(
      'SELECT display_name, bio, avatar_url, banner_url FROM users WHERE id = $1',
      [request.auth.userId]
    );
    if (!current.rowCount) {
      const error = new Error('user_not_found');
      error.statusCode = 404;
      throw error;
    }
    const row = current.rows[0];
    const displayName = request.body.displayName === undefined
      ? row.display_name : request.body.displayName.trim();
    const bio = request.body.bio === undefined ? row.bio : request.body.bio.trim();
    const avatarUrl = request.body.avatarUrl === undefined ? row.avatar_url : request.body.avatarUrl;
    const bannerUrl = request.body.bannerUrl === undefined ? row.banner_url : request.body.bannerUrl;
    const result = await getPool().query(
      `UPDATE users SET display_name = $2, bio = $3, avatar_url = $4, banner_url = $5, updated_at = now()
       WHERE id = $1
       RETURNING id, handle, handle_display, display_name, avatar_url, banner_url, bio, presence, last_seen_at, role`,
      [request.auth.userId, displayName, bio, avatarUrl, bannerUrl]
    );
    return { user: publicUser(result.rows[0]) };
  });

  app.put('/me/media', {
    bodyLimit: 7 * 1024 * 1024,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['kind', 'mimeType', 'dataBase64'],
        properties: {
          kind: { type: 'string', enum: ['avatar', 'banner'] },
          mimeType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
          dataBase64: { type: 'string', minLength: 4, maxLength: 7_000_000 }
        }
      }
    },
    config: { rateLimit: { max: 12, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    const content = Buffer.from(request.body.dataBase64, 'base64');
    const maximum = request.body.kind === 'avatar' ? 2 * 1024 * 1024 : 5 * 1024 * 1024;
    if (!content.length || content.length > maximum) {
      return reply.code(400).send({ error: 'media_too_large' });
    }
    await getPool().query(
      `INSERT INTO profile_media (user_id, kind, mime_type, content, byte_size)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, kind) DO UPDATE
       SET mime_type = EXCLUDED.mime_type, content = EXCLUDED.content,
           byte_size = EXCLUDED.byte_size, updated_at = now()`,
      [request.auth.userId, request.body.kind, request.body.mimeType, content, content.length]
    );
    return { kind: request.body.kind, mimeType: request.body.mimeType, dataBase64: content.toString('base64') };
  });

  app.get('/media/:userId/:kind', {
    schema: {
      params: {
        type: 'object', additionalProperties: false, required: ['userId', 'kind'],
        properties: {
          userId: { type: 'string', format: 'uuid' },
          kind: { type: 'string', enum: ['avatar', 'banner'] }
        }
      }
    }
  }, async (request, reply) => {
    const result = await getPool().query(
      'SELECT mime_type, content FROM profile_media WHERE user_id = $1 AND kind = $2',
      [request.params.userId, request.params.kind]
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'media_not_found' });
    return { mimeType: result.rows[0].mime_type, dataBase64: result.rows[0].content.toString('base64') };
  });

  app.get('/followers', async (request) => {
    const [followers, following] = await Promise.all([
      getPool().query(
        `SELECT u.id, u.handle, u.handle_display, u.display_name, u.avatar_url, u.banner_url, u.bio,
                u.presence, u.last_seen_at, u.role,
                (SELECT updated_at FROM profile_media WHERE user_id = u.id AND kind = 'avatar') AS avatar_media_updated_at,
                (SELECT updated_at FROM profile_media WHERE user_id = u.id AND kind = 'banner') AS banner_media_updated_at
         FROM followers f JOIN users u ON u.id = f.follower_id
         WHERE f.followed_id = $1 AND u.is_disabled = false ORDER BY f.created_at DESC`,
        [request.auth.userId]
      ),
      getPool().query(
        `SELECT u.id, u.handle, u.handle_display, u.display_name, u.avatar_url, u.banner_url, u.bio,
                u.presence, u.last_seen_at, u.role,
                (SELECT updated_at FROM profile_media WHERE user_id = u.id AND kind = 'avatar') AS avatar_media_updated_at,
                (SELECT updated_at FROM profile_media WHERE user_id = u.id AND kind = 'banner') AS banner_media_updated_at
         FROM followers f JOIN users u ON u.id = f.followed_id
         WHERE f.follower_id = $1 AND u.is_disabled = false ORDER BY f.created_at DESC`,
        [request.auth.userId]
      )
    ]);
    return { followers: followers.rows.map(publicUser), following: following.rows.map(publicUser) };
  });

  app.post('/followers/:userId', { schema: { params: userIdParams } }, async (request, reply) => {
    if (request.params.userId === request.auth.userId) return reply.code(400).send({ error: 'cannot_follow_self' });
    const result = await getPool().query(
      `INSERT INTO followers (follower_id, followed_id)
       SELECT $1, id FROM users WHERE id = $2 AND is_disabled = false
       ON CONFLICT DO NOTHING RETURNING followed_id`,
      [request.auth.userId, request.params.userId]
    );
    if (!result.rowCount) {
      const exists = await getPool().query('SELECT 1 FROM users WHERE id = $1 AND is_disabled = false', [request.params.userId]);
      if (!exists.rowCount) return reply.code(404).send({ error: 'user_not_found' });
    }
    return reply.code(201).send({ status: 'following' });
  });

  app.delete('/followers/:userId', { schema: { params: userIdParams } }, async (request, reply) => {
    await getPool().query('DELETE FROM followers WHERE follower_id = $1 AND followed_id = $2', [request.auth.userId, request.params.userId]);
    return reply.code(204).send();
  });

  app.get('/users/search', {
    schema: {
      querystring: {
        type: 'object', additionalProperties: false, required: ['q'],
        properties: { q: { type: 'string', minLength: 2, maxLength: 40 } }
      }
    }
  }, async (request) => {
    const query = normalizeHandle(request.query.q);
    const result = await getPool().query(
      `SELECT u.id, u.handle, u.handle_display, u.display_name, u.avatar_url, u.banner_url, u.bio,
              u.presence, u.last_seen_at, u.role,
              (SELECT updated_at FROM profile_media WHERE user_id = u.id AND kind = 'avatar') AS avatar_media_updated_at,
              (SELECT updated_at FROM profile_media WHERE user_id = u.id AND kind = 'banner') AS banner_media_updated_at,
              f.status AS friendship_status, f.requested_by
       FROM users u
       LEFT JOIN friendships f
         ON f.user_low_id = LEAST(u.id, $1::uuid)
        AND f.user_high_id = GREATEST(u.id, $1::uuid)
       WHERE u.id <> $1 AND u.is_disabled = false
         AND (u.handle::text ILIKE $2 OR u.display_name ILIKE $2)
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $1)
         )
       ORDER BY CASE WHEN u.handle::text = $3 THEN 0 ELSE 1 END, u.handle
       LIMIT 20`,
      [request.auth.userId, `%${query}%`, query]
    );
    return {
      users: result.rows.map((row) => ({
        ...publicUser(row),
        friendshipStatus: row.friendship_status,
        requestDirection: !row.friendship_status ? null
          : row.requested_by === request.auth.userId ? 'outgoing' : 'incoming'
      }))
    };
  });

  app.get('/friends', async (request) => {
    const result = await getPool().query(
      `SELECT f.status, f.requested_by, f.created_at, f.responded_at,
              u.id, u.handle, u.handle_display, u.display_name, u.avatar_url, u.banner_url, u.bio,
              u.presence, u.last_seen_at, u.role,
              (SELECT updated_at FROM profile_media WHERE user_id = u.id AND kind = 'avatar') AS avatar_media_updated_at,
              (SELECT updated_at FROM profile_media WHERE user_id = u.id AND kind = 'banner') AS banner_media_updated_at
       FROM friendships f
       JOIN users u ON u.id = CASE
         WHEN f.user_low_id = $1 THEN f.user_high_id ELSE f.user_low_id END
       WHERE (f.user_low_id = $1 OR f.user_high_id = $1) AND u.is_disabled = false
       ORDER BY f.status, u.handle`,
      [request.auth.userId]
    );
    const response = { friends: [], incoming: [], outgoing: [] };
    for (const row of result.rows) {
      const item = { user: publicUser(row), createdAt: row.created_at, respondedAt: row.responded_at };
      if (row.status === 'accepted') response.friends.push(item);
      else if (row.status === 'pending' && row.requested_by === request.auth.userId) response.outgoing.push(item);
      else if (row.status === 'pending') response.incoming.push(item);
    }
    return response;
  });

  app.post('/friends/requests', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['handle'],
        properties: { handle: { type: 'string', minLength: 3, maxLength: 25 } }
      }
    },
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    const target = await findUserByHandle(request.body.handle);
    if (!target) return reply.code(404).send({ error: 'user_not_found' });
    if (target.id === request.auth.userId) return reply.code(400).send({ error: 'cannot_friend_self' });

    try {
      await withTransaction(async (client) => {
        const blocked = await client.query(
          `SELECT 1 FROM user_blocks WHERE
            (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
          [request.auth.userId, target.id]
        );
        if (blocked.rowCount) {
          const error = new Error('user_not_found'); error.statusCode = 404; throw error;
        }
        const existing = await client.query(
          `SELECT * FROM friendships
           WHERE user_low_id = LEAST($1::uuid, $2::uuid)
             AND user_high_id = GREATEST($1::uuid, $2::uuid) FOR UPDATE`,
          [request.auth.userId, target.id]
        );
        const friendship = existing.rows[0];
        if (friendship?.status === 'accepted') {
          const error = new Error('already_friends'); error.statusCode = 409; throw error;
        }
        if (friendship?.status === 'pending') {
          const message = friendship.requested_by === request.auth.userId
            ? 'friend_request_exists' : 'incoming_request_exists';
          const error = new Error(message); error.statusCode = 409; throw error;
        }
        await client.query(
          `INSERT INTO friendships (user_low_id, user_high_id, requested_by, status)
           VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $1, 'pending')
           ON CONFLICT (user_low_id, user_high_id) DO UPDATE
           SET requested_by = EXCLUDED.requested_by, status = 'pending',
               created_at = now(), responded_at = NULL`,
          [request.auth.userId, target.id]
        );
      });
      return reply.code(201).send({ status: 'pending', user: publicUser(target) });
    } catch (error) {
      if (error.statusCode) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post('/friends/:userId/accept', { schema: { params: userIdParams } }, async (request, reply) => {
    const result = await getPool().query(
      `UPDATE friendships SET status = 'accepted', responded_at = now()
       WHERE user_low_id = LEAST($1::uuid, $2::uuid)
         AND user_high_id = GREATEST($1::uuid, $2::uuid)
         AND status = 'pending' AND requested_by = $2
       RETURNING requested_by`,
      [request.auth.userId, request.params.userId]
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'friend_request_not_found' });
    return { status: 'accepted' };
  });

  app.delete('/friends/:userId', { schema: { params: userIdParams } }, async (request, reply) => {
    await getPool().query(
      `DELETE FROM friendships
       WHERE user_low_id = LEAST($1::uuid, $2::uuid)
         AND user_high_id = GREATEST($1::uuid, $2::uuid)`,
      [request.auth.userId, request.params.userId]
    );
    return reply.code(204).send();
  });
}
