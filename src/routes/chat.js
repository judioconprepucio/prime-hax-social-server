import { requireAuth } from '../auth-middleware.js';
import { getPool, withTransaction } from '../db.js';

const uuidParams = (name) => ({
  type: 'object',
  additionalProperties: false,
  required: [name],
  properties: { [name]: { type: 'string', format: 'uuid' } }
});

function publicUser(row) {
  return {
    id: row.other_id,
    handle: `@${row.other_handle_display}`,
    displayName: row.other_display_name,
    avatarUrl: row.other_avatar_url,
    presence: row.other_presence,
    lastSeenAt: row.other_last_seen_at
  };
}

function publicMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: row.deleted_at ? null : row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at
  };
}

async function acceptedFriends(client, userId, otherId) {
  const result = await client.query(
    `SELECT 1 FROM friendships
     WHERE user_low_id = LEAST($1::uuid, $2::uuid)
       AND user_high_id = GREATEST($1::uuid, $2::uuid)
       AND status = 'accepted'`,
    [userId, otherId]
  );
  return result.rowCount > 0;
}

async function requireConversationMember(conversationId, userId) {
  const result = await getPool().query(
    `SELECT 1 FROM conversation_members
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  return result.rowCount > 0;
}

export async function chatRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/conversations', async (request) => {
    const result = await getPool().query(
      `SELECT c.id, c.updated_at,
              other.id AS other_id, other.handle_display AS other_handle_display,
              other.display_name AS other_display_name, other.avatar_url AS other_avatar_url,
              other.presence AS other_presence, other.last_seen_at AS other_last_seen_at,
              last_message.id AS last_message_id, last_message.sender_id AS last_sender_id,
              last_message.body AS last_body, last_message.created_at AS last_created_at,
              last_message.edited_at AS last_edited_at, last_message.deleted_at AS last_deleted_at,
              unread.unread_count
       FROM conversation_members mine
       JOIN conversations c ON c.id = mine.conversation_id AND c.kind = 'direct'
       JOIN conversation_members theirs ON theirs.conversation_id = c.id AND theirs.user_id <> $1
       JOIN users other ON other.id = theirs.user_id AND other.is_disabled = false
       LEFT JOIN LATERAL (
         SELECT m.* FROM messages m
         WHERE m.conversation_id = c.id
         ORDER BY m.created_at DESC, m.id DESC LIMIT 1
       ) last_message ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS unread_count FROM messages m
         WHERE m.conversation_id = c.id AND m.sender_id <> $1
           AND m.deleted_at IS NULL
           AND (mine.last_read_at IS NULL OR m.created_at > mine.last_read_at)
       ) unread ON true
       WHERE mine.user_id = $1
       ORDER BY COALESCE(last_message.created_at, c.updated_at) DESC`,
      [request.auth.userId]
    );
    return {
      conversations: result.rows.map((row) => ({
        id: row.id,
        user: publicUser(row),
        unreadCount: row.unread_count || 0,
        updatedAt: row.updated_at,
        lastMessage: row.last_message_id ? publicMessage({
          id: row.last_message_id,
          conversation_id: row.id,
          sender_id: row.last_sender_id,
          body: row.last_body,
          created_at: row.last_created_at,
          edited_at: row.last_edited_at,
          deleted_at: row.last_deleted_at
        }) : null
      }))
    };
  });

  app.post('/conversations/direct/:userId', {
    schema: { params: uuidParams('userId') }
  }, async (request, reply) => {
    const otherId = request.params.userId;
    if (otherId === request.auth.userId) {
      return reply.code(400).send({ error: 'cannot_message_self' });
    }
    try {
      const conversationId = await withTransaction(async (client) => {
        if (!await acceptedFriends(client, request.auth.userId, otherId)) {
          const error = new Error('friendship_required');
          error.statusCode = 403;
          throw error;
        }
        const conversation = await client.query(
          `INSERT INTO conversations (kind, direct_user_low_id, direct_user_high_id)
           VALUES ('direct', LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))
           ON CONFLICT (direct_user_low_id, direct_user_high_id) WHERE kind = 'direct'
           DO UPDATE SET updated_at = conversations.updated_at
           RETURNING id`,
          [request.auth.userId, otherId]
        );
        const id = conversation.rows[0].id;
        await client.query(
          `INSERT INTO conversation_members (conversation_id, user_id)
           VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING`,
          [id, request.auth.userId, otherId]
        );
        return id;
      });
      return reply.code(201).send({ conversationId });
    } catch (error) {
      if (error.statusCode) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.get('/conversations/:conversationId/messages', {
    schema: {
      params: uuidParams('conversationId'),
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          before: { type: 'string', format: 'date-time' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
        }
      }
    }
  }, async (request, reply) => {
    const conversationId = request.params.conversationId;
    if (!await requireConversationMember(conversationId, request.auth.userId)) {
      return reply.code(404).send({ error: 'conversation_not_found' });
    }
    const result = await getPool().query(
      `SELECT id, conversation_id, sender_id, body, created_at, edited_at, deleted_at
       FROM messages
       WHERE conversation_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [conversationId, request.query.before || null, request.query.limit || 50]
    );
    await getPool().query(
      `UPDATE conversation_members SET last_read_at = now()
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, request.auth.userId]
    );
    return { messages: result.rows.reverse().map(publicMessage) };
  });

  app.post('/conversations/:conversationId/messages', {
    schema: {
      params: uuidParams('conversationId'),
      body: {
        type: 'object', additionalProperties: false, required: ['body'],
        properties: { body: { type: 'string', minLength: 1, maxLength: 2000 } }
      }
    },
    config: { rateLimit: { max: 90, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const body = request.body.body.trim();
    if (!body) return reply.code(400).send({ error: 'empty_message' });
    try {
      const message = await withTransaction(async (client) => {
        const access = await client.query(
          `SELECT other_member.user_id AS other_id
           FROM conversation_members mine
           JOIN conversation_members other_member
             ON other_member.conversation_id = mine.conversation_id
            AND other_member.user_id <> $2
           WHERE mine.conversation_id = $1 AND mine.user_id = $2`,
          [request.params.conversationId, request.auth.userId]
        );
        if (!access.rowCount) {
          const error = new Error('conversation_not_found');
          error.statusCode = 404;
          throw error;
        }
        if (!await acceptedFriends(client, request.auth.userId, access.rows[0].other_id)) {
          const error = new Error('friendship_required');
          error.statusCode = 403;
          throw error;
        }
        const inserted = await client.query(
          `INSERT INTO messages (conversation_id, sender_id, body)
           VALUES ($1, $2, $3)
           RETURNING id, conversation_id, sender_id, body, created_at, edited_at, deleted_at`,
          [request.params.conversationId, request.auth.userId, body]
        );
        await client.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [request.params.conversationId]);
        await client.query(
          `UPDATE conversation_members SET last_read_at = now()
           WHERE conversation_id = $1 AND user_id = $2`,
          [request.params.conversationId, request.auth.userId]
        );
        return inserted.rows[0];
      });
      return reply.code(201).send({ message: publicMessage(message) });
    } catch (error) {
      if (error.statusCode) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post('/room-invites', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['receiverId', 'roomUrl'],
        properties: {
          receiverId: { type: 'string', format: 'uuid' },
          roomUrl: { type: 'string', pattern: '^https://(www\\.)?haxball\\.com/play\\?c=', maxLength: 500 },
          roomName: { type: 'string', maxLength: 160 }
        }
      }
    },
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    if (!await acceptedFriends(getPool(), request.auth.userId, request.body.receiverId)) {
      return reply.code(403).send({ error: 'friendship_required' });
    }
    const result = await getPool().query(
      `INSERT INTO room_invites (sender_id, receiver_id, room_url, room_name, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '15 minutes')
       RETURNING id, room_url, room_name, status, expires_at, created_at`,
      [request.auth.userId, request.body.receiverId, request.body.roomUrl, request.body.roomName?.trim() || null]
    );
    return reply.code(201).send({ invite: result.rows[0] });
  });

  app.get('/room-invites', async (request) => {
    await getPool().query(
      `UPDATE room_invites SET status = 'expired', responded_at = now()
       WHERE receiver_id = $1 AND status = 'pending' AND expires_at <= now()`,
      [request.auth.userId]
    );
    const result = await getPool().query(
      `SELECT i.id, i.room_url, i.room_name, i.status, i.expires_at, i.created_at,
              u.id AS other_id, u.handle_display AS other_handle_display,
              u.display_name AS other_display_name, u.avatar_url AS other_avatar_url,
              u.presence AS other_presence, u.last_seen_at AS other_last_seen_at
       FROM room_invites i JOIN users u ON u.id = i.sender_id
       WHERE i.receiver_id = $1 AND i.status = 'pending' AND i.expires_at > now()
       ORDER BY i.created_at DESC LIMIT 30`,
      [request.auth.userId]
    );
    return { invites: result.rows.map((row) => ({
      id: row.id,
      roomUrl: row.room_url,
      roomName: row.room_name,
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      sender: publicUser(row)
    })) };
  });

  app.post('/room-invites/:inviteId/respond', {
    schema: {
      params: uuidParams('inviteId'),
      body: {
        type: 'object', additionalProperties: false, required: ['action'],
        properties: { action: { type: 'string', enum: ['accepted', 'declined'] } }
      }
    }
  }, async (request, reply) => {
    const result = await getPool().query(
      `UPDATE room_invites SET status = $3, responded_at = now()
       WHERE id = $1 AND receiver_id = $2 AND status = 'pending' AND expires_at > now()
       RETURNING room_url, room_name, status`,
      [request.params.inviteId, request.auth.userId, request.body.action]
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'invite_not_found' });
    return {
      status: result.rows[0].status,
      roomUrl: request.body.action === 'accepted' ? result.rows[0].room_url : null,
      roomName: result.rows[0].room_name
    };
  });
}
