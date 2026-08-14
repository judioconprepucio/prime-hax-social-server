import argon2 from 'argon2';
import { getPool, withTransaction } from '../db.js';
import { securityConfig } from '../config.js';
import {
  hashNonce,
  hashWithPepper,
  normalizeHandle,
  randomToken,
  safeHexEqual,
  validateDevicePublicKey,
  verifyDeviceSignature
} from '../security.js';
import { createSession } from '../sessions.js';

const HANDLE_PATTERN = '^[a-z0-9][a-z0-9_-]{2,23}$';
const PUBLIC_KEY_MAX = 1000;

function requestMetadata(request) {
  return {
    ipAddress: request.ip,
    userAgent: String(request.headers['user-agent'] || '').slice(0, 500)
  };
}

function publicUser(row) {
  return {
    id: row.id,
    handle: `@${row.handle_display}`,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    role: row.role
  };
}

const registerSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['invitationCode', 'handle', 'password', 'displayName', 'deviceName', 'publicKey'],
    properties: {
      invitationCode: { type: 'string', minLength: 20, maxLength: 200 },
      handle: { type: 'string', minLength: 3, maxLength: 25 },
      password: { type: 'string', minLength: 12, maxLength: 128 },
      displayName: { type: 'string', minLength: 1, maxLength: 40 },
      deviceName: { type: 'string', minLength: 1, maxLength: 120 },
      publicKey: { type: 'string', minLength: 50, maxLength: PUBLIC_KEY_MAX }
    }
  }
};

export async function authRoutes(app) {
  app.post('/register', { schema: registerSchema, config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const config = securityConfig();
    const handleDisplay = String(request.body.handle).trim().replace(/^@/, '');
    const handle = normalizeHandle(request.body.handle);
    if (!(new RegExp(HANDLE_PATTERN)).test(handle)) {
      return reply.code(400).send({ error: 'invalid_handle' });
    }

    let deviceKey;
    try {
      deviceKey = validateDevicePublicKey(request.body.publicKey);
    } catch {
      return reply.code(400).send({ error: 'invalid_device_key' });
    }

    const inviteHash = hashWithPepper(request.body.invitationCode, config.invitePepper);
    const passwordHash = await argon2.hash(request.body.password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1
    });

    try {
      const result = await withTransaction(async (client) => {
        const inviteResult = await client.query(
          `SELECT * FROM invitation_codes WHERE code_hash = $1 FOR UPDATE`,
          [inviteHash]
        );
        const invite = inviteResult.rows[0];
        if (!invite || invite.redeemed_at || invite.revoked_at || new Date(invite.expires_at) <= new Date()) {
          const error = new Error('invalid_invitation');
          error.statusCode = 403;
          throw error;
        }
        if (invite.intended_handle && String(invite.intended_handle).toLowerCase() !== handle) {
          const error = new Error('invitation_handle_mismatch');
          error.statusCode = 403;
          throw error;
        }

        const userResult = await client.query(
          `INSERT INTO users (handle, handle_display, password_hash, display_name, role)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, handle, handle_display, display_name, avatar_url, bio, role`,
          [handle, handleDisplay, passwordHash, request.body.displayName.trim(), invite.granted_role]
        );
        const user = userResult.rows[0];

        const deviceResult = await client.query(
          `INSERT INTO trusted_devices (user_id, device_name, public_key, fingerprint)
           VALUES ($1, $2, $3, $4)
           RETURNING id, device_name`,
          [user.id, request.body.deviceName.trim(), request.body.publicKey, deviceKey.fingerprint]
        );
        const device = deviceResult.rows[0];

        await client.query(
          `UPDATE invitation_codes
           SET redeemed_by = $1, redeemed_at = now()
           WHERE id = $2`,
          [user.id, invite.id]
        );

        const recoveryCodes = Array.from({ length: 8 }, () => `PHX-R-${randomToken(10)}`);
        for (const code of recoveryCodes) {
          await client.query(
            `INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)`,
            [user.id, hashWithPepper(code, config.recoveryPepper)]
          );
        }

        const session = await createSession(client, {
          userId: user.id,
          deviceId: device.id,
          deviceName: device.device_name,
          ...requestMetadata(request)
        });

        await client.query(
          `INSERT INTO security_audit_events
            (user_id, event_type, device_id, ip_address)
           VALUES ($1, 'account_registered', $2, $3)`,
          [user.id, device.id, request.ip]
        );

        return { user: publicUser(user), deviceId: device.id, recoveryCodes, ...session };
      });
      return reply.code(201).send(result);
    } catch (error) {
      if (error.code === '23505') return reply.code(409).send({ error: 'handle_unavailable' });
      if (error.statusCode) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post('/challenge', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['handle', 'deviceFingerprint'],
        properties: {
          handle: { type: 'string', minLength: 3, maxLength: 25 },
          deviceFingerprint: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' }
        }
      }
    },
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    const handle = normalizeHandle(request.body.handle);
    const deviceResult = await getPool().query(
      `SELECT d.id
       FROM trusted_devices d
       JOIN users u ON u.id = d.user_id
       WHERE u.handle = $1 AND d.fingerprint = lower($2)
         AND u.is_disabled = false AND d.revoked_at IS NULL`,
      [handle, request.body.deviceFingerprint]
    );
    if (!deviceResult.rowCount) return reply.code(404).send({ error: 'invalid_login' });

    const nonce = randomToken(32);
    const expiresAt = new Date(Date.now() + 120_000);
    const challengeResult = await getPool().query(
      `INSERT INTO device_challenges (device_id, nonce_hash, expires_at)
       VALUES ($1, $2, $3) RETURNING id`,
      [deviceResult.rows[0].id, hashNonce(nonce), expiresAt]
    );
    return { challengeId: challengeResult.rows[0].id, nonce, expiresAt: expiresAt.toISOString() };
  });

  app.post('/login', {
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        required: ['handle', 'password', 'challengeId', 'nonce', 'signature'],
        properties: {
          handle: { type: 'string', minLength: 3, maxLength: 25 },
          password: { type: 'string', minLength: 1, maxLength: 128 },
          challengeId: { type: 'string', format: 'uuid' },
          nonce: { type: 'string', minLength: 20, maxLength: 200 },
          signature: { type: 'string', minLength: 40, maxLength: 500 }
        }
      }
    },
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    const handle = normalizeHandle(request.body.handle);
    const result = await getPool().query(
      `SELECT c.id AS challenge_id, c.nonce_hash, c.expires_at, c.consumed_at,
              d.id AS device_id, d.device_name, d.public_key, d.revoked_at,
              u.id, u.handle, u.handle_display, u.display_name, u.avatar_url, u.bio, u.role,
              u.password_hash, u.is_disabled
       FROM device_challenges c
       JOIN trusted_devices d ON d.id = c.device_id
       JOIN users u ON u.id = d.user_id
       WHERE c.id = $1 AND u.handle = $2`,
      [request.body.challengeId, handle]
    );
    const row = result.rows[0];
    const suppliedHash = hashNonce(request.body.nonce);
    const challengeValid = row && !row.consumed_at && new Date(row.expires_at) > new Date()
      && !row.revoked_at && !row.is_disabled && safeHexEqual(row.nonce_hash, suppliedHash)
      && verifyDeviceSignature(row.public_key, request.body.nonce, request.body.signature);
    if (!challengeValid || !row.password_hash || !(await argon2.verify(row.password_hash, request.body.password))) {
      return reply.code(401).send({ error: 'invalid_login' });
    }

    const response = await withTransaction(async (client) => {
      const consumed = await client.query(
        `UPDATE device_challenges SET consumed_at = now()
         WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
         RETURNING id`,
        [row.challenge_id]
      );
      if (!consumed.rowCount) {
        const error = new Error('invalid_login');
        error.statusCode = 401;
        throw error;
      }
      await client.query(`UPDATE trusted_devices SET last_used_at = now() WHERE id = $1`, [row.device_id]);
      await client.query(`UPDATE users SET last_seen_at = now(), presence = 'online' WHERE id = $1`, [row.id]);
      const session = await createSession(client, {
        userId: row.id,
        deviceId: row.device_id,
        deviceName: row.device_name,
        ...requestMetadata(request)
      });
      await client.query(
        `INSERT INTO security_audit_events
          (user_id, event_type, device_id, ip_address)
         VALUES ($1, 'login_succeeded', $2, $3)`,
        [row.id, row.device_id, request.ip]
      );
      return { user: publicUser(row), deviceId: row.device_id, ...session };
    });
    return response;
  });

  app.post('/refresh', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['refreshToken'],
        properties: { refreshToken: { type: 'string', minLength: 30, maxLength: 200 } }
      }
    },
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    const config = securityConfig();
    const tokenHash = hashWithPepper(request.body.refreshToken, config.refreshPepper);
    try {
      return await withTransaction(async (client) => {
        const result = await client.query(
          `SELECT s.*, u.is_disabled, d.revoked_at AS device_revoked_at
           FROM refresh_sessions s
           JOIN users u ON u.id = s.user_id
           JOIN trusted_devices d ON d.id = s.device_id
           WHERE s.token_hash = $1 FOR UPDATE OF s`,
          [tokenHash]
        );
        const session = result.rows[0];
        if (!session || session.revoked_at || session.device_revoked_at || session.is_disabled
          || new Date(session.expires_at) <= new Date()) {
          const error = new Error('invalid_session');
          error.statusCode = 401;
          throw error;
        }
        await client.query(`UPDATE refresh_sessions SET revoked_at = now() WHERE id = $1`, [session.id]);
        return createSession(client, {
          userId: session.user_id,
          deviceId: session.device_id,
          deviceName: session.device_name,
          ...requestMetadata(request)
        });
      });
    } catch (error) {
      if (error.statusCode) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post('/logout', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['refreshToken'],
        properties: { refreshToken: { type: 'string', minLength: 30, maxLength: 200 } }
      }
    }
  }, async (request, reply) => {
    const config = securityConfig();
    const tokenHash = hashWithPepper(request.body.refreshToken, config.refreshPepper);
    await getPool().query(
      `UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE token_hash = $1`,
      [tokenHash]
    );
    return reply.code(204).send();
  });
}
