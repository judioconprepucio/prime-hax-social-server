import crypto from 'node:crypto';
import { requireAuth } from '../auth-middleware.js';
import { getPool, withTransaction } from '../db.js';
import { canManageMusicCatalog, publicPlaylist, publicTrack, safeAudioFilename } from '../music-utils.js';
import { getMusicBucket, getStorageConfig } from '../storage.js';

const uuidParams = (name) => ({
  type: 'object', additionalProperties: false, required: [name],
  properties: { [name]: { type: 'string', format: 'uuid' } }
});

const playlistTrackParams = {
  type: 'object', additionalProperties: false, required: ['playlistId', 'trackId'],
  properties: {
    playlistId: { type: 'string', format: 'uuid' },
    trackId: { type: 'string', format: 'uuid' }
  }
};

async function userRole(userId) {
  const result = await getPool().query(
    'SELECT role FROM users WHERE id = $1 AND is_disabled = false',
    [userId]
  );
  return result.rows[0]?.role || null;
}

async function catalogManager(userId) {
  return canManageMusicCatalog(await userRole(userId));
}

async function musicSessionAccess(client, sessionId, userId) {
  const result = await client.query(
    `SELECT s.*,
            u.role,
            EXISTS (
              SELECT 1 FROM music_djs d
              WHERE d.session_id = s.id AND d.user_id = $2 AND d.revoked_at IS NULL
            ) AS is_dj
     FROM music_sessions s
     JOIN users u ON u.id = $2 AND u.is_disabled = false
     WHERE s.id = $1 AND s.ended_at IS NULL`,
    [sessionId, userId]
  );
  const session = result.rows[0];
  if (!session) return null;
  return {
    session,
    elevated: ['admin', 'developer'].includes(session.role),
    canControl: session.owner_id === userId || session.is_dj || ['admin', 'developer'].includes(session.role),
    canManageDjs: session.owner_id === userId || ['admin', 'developer'].includes(session.role)
  };
}

async function publicMusicSession(roomFingerprint, userId) {
  const result = await getPool().query(
    `SELECT s.*, t.title, t.artist, t.album, t.duration_ms, t.mime_type,
            owner.handle_display AS owner_handle_display,
            viewer.role AS viewer_role,
            EXISTS (
              SELECT 1 FROM music_djs d
              WHERE d.session_id = s.id AND d.user_id = $2 AND d.revoked_at IS NULL
            ) AS viewer_is_dj
     FROM music_sessions s
     JOIN users owner ON owner.id = s.owner_id
     JOIN users viewer ON viewer.id = $2 AND viewer.is_disabled = false
     LEFT JOIN music_tracks t ON t.id = s.current_track_id AND t.status = 'ready'
     WHERE s.room_fingerprint = $1 AND s.ended_at IS NULL`,
    [roomFingerprint, userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const elapsed = row.playback_state === 'playing' && row.track_started_at
    ? Math.max(0, Date.now() - new Date(row.track_started_at).getTime())
    : 0;
  const queue = await getPool().query(
    `SELECT q.id, q.position, q.status, t.id AS track_id, t.title, t.artist, t.duration_ms
     FROM music_queue q
     JOIN music_tracks t ON t.id = q.track_id
     WHERE q.session_id = $1 AND q.status IN ('queued', 'playing')
     ORDER BY q.position LIMIT 100`,
    [row.id]
  );
  const djs = await getPool().query(
    `SELECT u.id, u.handle_display, u.display_name
     FROM music_djs d JOIN users u ON u.id = d.user_id
     WHERE d.session_id = $1 AND d.revoked_at IS NULL
     ORDER BY lower(u.handle_display)`,
    [row.id]
  );
  return {
    id: row.id,
    roomFingerprint: row.room_fingerprint,
    roomName: row.room_name,
    ownerHandle: `@${row.owner_handle_display}`,
    playbackState: row.playback_state,
    positionMs: Number(row.paused_position_ms) + elapsed,
    shuffleEnabled: row.shuffle_enabled,
    repeatMode: row.repeat_mode,
    autoDjEnabled: row.auto_dj_enabled,
    masterVolume: row.master_volume,
    stateVersion: Number(row.state_version),
    currentTrack: row.current_track_id ? {
      id: row.current_track_id, title: row.title, artist: row.artist, album: row.album,
      durationMs: row.duration_ms, mimeType: row.mime_type
    } : null,
    canControl: row.owner_id === userId || row.viewer_is_dj || ['admin', 'developer'].includes(row.viewer_role),
    canManageDjs: row.owner_id === userId || ['admin', 'developer'].includes(row.viewer_role),
    djs: djs.rows.map((dj) => ({ id: dj.id, handle: `@${dj.handle_display}`, displayName: dj.display_name })),
    queue: queue.rows.map((item) => ({
      id: item.id, position: Number(item.position), status: item.status,
      track: { id: item.track_id, title: item.title, artist: item.artist, durationMs: item.duration_ms }
    }))
  };
}

async function playlistAccess(playlistId, userId) {
  const result = await getPool().query(
    `SELECT p.*, u.handle_display AS owner_handle_display
     FROM music_playlists p
     LEFT JOIN users u ON u.id = p.owner_id
     WHERE p.id = $1`,
    [playlistId]
  );
  const playlist = result.rows[0];
  if (!playlist) return null;
  const manager = await catalogManager(userId);
  return {
    playlist,
    canRead: playlist.visibility === 'group' || playlist.owner_id === userId || manager,
    canEdit: playlist.owner_id === userId || manager
  };
}

function storageFailure(app, operation, error) {
  app.log.error({ err: error, operation }, 'Supabase Storage operation failed');
}

async function recordMusicEvent(client, sessionId, actorId, eventType, payload = {}) {
  const version = await client.query(
    'UPDATE music_sessions SET state_version = state_version + 1, last_heartbeat_at = now() WHERE id = $1 RETURNING state_version',
    [sessionId]
  );
  const stateVersion = Number(version.rows[0].state_version);
  await client.query(
    'INSERT INTO music_events (session_id, actor_id, event_type, state_version, payload) VALUES ($1, $2, $3, $4, $5)',
    [sessionId, actorId, eventType, stateVersion, JSON.stringify(payload)]
  );
  return stateVersion;
}

function currentPositionMs(session) {
  if (session.playback_state !== 'playing' || !session.track_started_at) return Number(session.paused_position_ms || 0);
  return Math.max(0, Number(session.paused_position_ms || 0) + Date.now() - new Date(session.track_started_at).getTime());
}

async function selectQueueTrack(client, sessionId, direction = 'next') {
  if (direction === 'previous') {
    const previous = await client.query(
      `SELECT q.*, t.duration_ms FROM music_queue q JOIN music_tracks t ON t.id = q.track_id
       WHERE q.session_id = $1 AND q.status IN ('played', 'skipped')
       ORDER BY q.finished_at DESC NULLS LAST, q.position DESC LIMIT 1`,
      [sessionId]
    );
    return previous.rows[0] || null;
  }
  const next = await client.query(
    `SELECT q.*, t.duration_ms FROM music_queue q JOIN music_tracks t ON t.id = q.track_id
     WHERE q.session_id = $1 AND q.status = 'queued' ORDER BY q.position LIMIT 1`,
    [sessionId]
  );
  return next.rows[0] || null;
}

export async function musicRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.post('/sessions/connect', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['roomFingerprint'],
        properties: {
          roomFingerprint: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          roomName: { type: 'string', maxLength: 160 }
        }
      }
    }
  }, async (request) => {
    await getPool().query(
      `INSERT INTO music_sessions (room_fingerprint, room_name, owner_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (room_fingerprint) WHERE ended_at IS NULL
       DO UPDATE SET room_name = COALESCE(EXCLUDED.room_name, music_sessions.room_name), last_heartbeat_at = now()`,
      [request.body.roomFingerprint, request.body.roomName?.trim() || null, request.auth.userId]
    );
    return { session: await publicMusicSession(request.body.roomFingerprint, request.auth.userId) };
  });

  app.get('/sessions/room/:roomFingerprint', {
    schema: {
      params: {
        type: 'object', additionalProperties: false, required: ['roomFingerprint'],
        properties: { roomFingerprint: { type: 'string', pattern: '^[0-9a-f]{64}$' } }
      }
    }
  }, async (request, reply) => {
    const session = await publicMusicSession(request.params.roomFingerprint, request.auth.userId);
    if (!session) return reply.code(404).send({ error: 'music_session_not_found' });
    return { session };
  });

  app.post('/sessions/:sessionId/control', {
    schema: {
      params: uuidParams('sessionId'),
      body: {
        type: 'object', additionalProperties: false, required: ['action'],
        properties: {
          action: { type: 'string', enum: ['play', 'pause', 'resume', 'stop', 'next', 'previous', 'shuffle', 'repeat', 'autodj'] },
          trackId: { type: 'string', format: 'uuid' },
          enabled: { type: 'boolean' },
          repeatMode: { type: 'string', enum: ['off', 'track', 'playlist'] }
        }
      }
    }
  }, async (request, reply) => {
    let roomFingerprint;
    const result = await withTransaction(async (client) => {
      const access = await musicSessionAccess(client, request.params.sessionId, request.auth.userId);
      if (!access) return { status: 404, error: 'music_session_not_found' };
      if (!access.canControl) return { status: 403, error: 'music_dj_permission_required' };
      await client.query('SELECT id FROM music_sessions WHERE id = $1 FOR UPDATE', [request.params.sessionId]);
      const session = (await client.query('SELECT * FROM music_sessions WHERE id = $1', [request.params.sessionId])).rows[0];
      roomFingerprint = session.room_fingerprint;
      const action = request.body.action;
      if (action === 'play') {
        if (!request.body.trackId) return { status: 400, error: 'music_track_required' };
        const track = await client.query("SELECT id FROM music_tracks WHERE id = $1 AND status = 'ready'", [request.body.trackId]);
        if (!track.rowCount) return { status: 404, error: 'music_track_not_found' };
        await client.query(
          `UPDATE music_sessions SET current_track_id = $2, playback_state = 'playing',
           track_started_at = now(), paused_position_ms = 0 WHERE id = $1`,
          [session.id, request.body.trackId]
        );
      } else if (action === 'pause') {
        if (session.playback_state === 'playing') {
          await client.query(
            "UPDATE music_sessions SET playback_state = 'paused', paused_position_ms = $2, track_started_at = NULL WHERE id = $1",
            [session.id, Math.floor(currentPositionMs(session))]
          );
        }
      } else if (action === 'resume') {
        if (session.current_track_id && session.playback_state !== 'playing') {
          await client.query("UPDATE music_sessions SET playback_state = 'playing', track_started_at = now() WHERE id = $1", [session.id]);
        }
      } else if (action === 'stop') {
        await client.query("UPDATE music_sessions SET playback_state = 'stopped', current_track_id = NULL, track_started_at = NULL, paused_position_ms = 0 WHERE id = $1", [session.id]);
      } else if (action === 'shuffle') {
        const enabled = request.body.enabled ?? !session.shuffle_enabled;
        await client.query('UPDATE music_sessions SET shuffle_enabled = $2 WHERE id = $1', [session.id, enabled]);
      } else if (action === 'repeat') {
        const mode = request.body.repeatMode || (session.repeat_mode === 'off' ? 'track' : session.repeat_mode === 'track' ? 'playlist' : 'off');
        await client.query('UPDATE music_sessions SET repeat_mode = $2 WHERE id = $1', [session.id, mode]);
      } else if (action === 'autodj') {
        const enabled = request.body.enabled ?? !session.auto_dj_enabled;
        await client.query('UPDATE music_sessions SET auto_dj_enabled = $2 WHERE id = $1', [session.id, enabled]);
      } else {
        await client.query(
          "UPDATE music_queue SET status = CASE WHEN status = 'playing' THEN $2 ELSE status END, finished_at = CASE WHEN status = 'playing' THEN now() ELSE finished_at END WHERE session_id = $1",
          [session.id, action === 'next' ? 'skipped' : 'played']
        );
        const selected = await selectQueueTrack(client, session.id, action);
        if (selected) {
          await client.query("UPDATE music_queue SET status = 'playing', started_at = now(), finished_at = NULL WHERE id = $1", [selected.id]);
          await client.query("UPDATE music_sessions SET current_track_id = $2, playback_state = 'playing', track_started_at = now(), paused_position_ms = 0 WHERE id = $1", [session.id, selected.track_id]);
        } else {
          await client.query("UPDATE music_sessions SET current_track_id = NULL, playback_state = 'stopped', track_started_at = NULL, paused_position_ms = 0 WHERE id = $1", [session.id]);
        }
      }
      await recordMusicEvent(client, session.id, request.auth.userId, `control_${action}`, request.body);
      return { status: 200 };
    });
    if (result.error) return reply.code(result.status).send({ error: result.error });
    return { session: await publicMusicSession(roomFingerprint, request.auth.userId) };
  });

  app.post('/sessions/:sessionId/queue', {
    schema: {
      params: uuidParams('sessionId'),
      body: {
        type: 'object', additionalProperties: false, required: ['trackId'],
        properties: { trackId: { type: 'string', format: 'uuid' } }
      }
    }
  }, async (request, reply) => {
    let roomFingerprint;
    const result = await withTransaction(async (client) => {
      const access = await musicSessionAccess(client, request.params.sessionId, request.auth.userId);
      if (!access) return { status: 404, error: 'music_session_not_found' };
      if (!access.canControl) return { status: 403, error: 'music_dj_permission_required' };
      roomFingerprint = access.session.room_fingerprint;
      const track = await client.query("SELECT id FROM music_tracks WHERE id = $1 AND status = 'ready'", [request.body.trackId]);
      if (!track.rowCount) return { status: 404, error: 'music_track_not_found' };
      await client.query('SELECT id FROM music_sessions WHERE id = $1 FOR UPDATE', [request.params.sessionId]);
      const position = (await client.query('SELECT COALESCE(max(position), -1) + 1 AS next FROM music_queue WHERE session_id = $1', [request.params.sessionId])).rows[0].next;
      await client.query('INSERT INTO music_queue (session_id, track_id, added_by, position) VALUES ($1, $2, $3, $4)', [request.params.sessionId, request.body.trackId, request.auth.userId, position]);
      await recordMusicEvent(client, request.params.sessionId, request.auth.userId, 'queue_add', { trackId: request.body.trackId });
      return { status: 201 };
    });
    if (result.error) return reply.code(result.status).send({ error: result.error });
    return reply.code(201).send({ session: await publicMusicSession(roomFingerprint, request.auth.userId) });
  });

  app.post('/sessions/:sessionId/queue/playlist', {
    schema: {
      params: uuidParams('sessionId'),
      body: {
        type: 'object', additionalProperties: false, required: ['playlistId'],
        properties: { playlistId: { type: 'string', format: 'uuid' } }
      }
    }
  }, async (request, reply) => {
    let roomFingerprint;
    const result = await withTransaction(async (client) => {
      const access = await musicSessionAccess(client, request.params.sessionId, request.auth.userId);
      if (!access) return { status: 404, error: 'music_session_not_found' };
      if (!access.canControl) return { status: 403, error: 'music_dj_permission_required' };
      roomFingerprint = access.session.room_fingerprint;
      const playlist = await playlistAccess(request.body.playlistId, request.auth.userId);
      if (!playlist?.canRead) return { status: 404, error: 'music_playlist_not_found' };
      await client.query('SELECT id FROM music_sessions WHERE id = $1 FOR UPDATE', [request.params.sessionId]);
      const tracks = await client.query(
        `SELECT pt.track_id FROM music_playlist_tracks pt JOIN music_tracks t ON t.id = pt.track_id AND t.status = 'ready'
         WHERE pt.playlist_id = $1 ORDER BY pt.position`, [request.body.playlistId]
      );
      let position = Number((await client.query('SELECT COALESCE(max(position), -1) + 1 AS next FROM music_queue WHERE session_id = $1', [request.params.sessionId])).rows[0].next);
      for (const row of tracks.rows) {
        await client.query('INSERT INTO music_queue (session_id, track_id, added_by, position) VALUES ($1, $2, $3, $4)', [request.params.sessionId, row.track_id, request.auth.userId, position++]);
      }
      await recordMusicEvent(client, request.params.sessionId, request.auth.userId, 'queue_playlist', { playlistId: request.body.playlistId, count: tracks.rowCount });
      return { status: 201 };
    });
    if (result.error) return reply.code(result.status).send({ error: result.error });
    return reply.code(201).send({ session: await publicMusicSession(roomFingerprint, request.auth.userId) });
  });

  app.post('/sessions/:sessionId/djs', {
    schema: {
      params: uuidParams('sessionId'),
      body: {
        type: 'object', additionalProperties: false, required: ['handle'],
        properties: { handle: { type: 'string', minLength: 3, maxLength: 25 } }
      }
    }
  }, async (request, reply) => {
    let roomFingerprint;
    const result = await withTransaction(async (client) => {
      const access = await musicSessionAccess(client, request.params.sessionId, request.auth.userId);
      if (!access) return { status: 404, error: 'music_session_not_found' };
      if (!access.canManageDjs) return { status: 403, error: 'music_dj_management_required' };
      roomFingerprint = access.session.room_fingerprint;
      const handle = request.body.handle.trim().replace(/^@/, '').toLowerCase();
      const user = await client.query('SELECT id FROM users WHERE handle = $1 AND is_disabled = false', [handle]);
      if (!user.rowCount) return { status: 404, error: 'user_not_found' };
      await client.query(
        `INSERT INTO music_djs (session_id, user_id, granted_by) VALUES ($1, $2, $3)
         ON CONFLICT (session_id, user_id) DO UPDATE SET granted_by = EXCLUDED.granted_by, granted_at = now(), revoked_at = NULL`,
        [request.params.sessionId, user.rows[0].id, request.auth.userId]
      );
      await recordMusicEvent(client, request.params.sessionId, request.auth.userId, 'dj_add', { userId: user.rows[0].id });
      return { status: 201 };
    });
    if (result.error) return reply.code(result.status).send({ error: result.error });
    return reply.code(201).send({ session: await publicMusicSession(roomFingerprint, request.auth.userId) });
  });

  app.delete('/sessions/:sessionId/djs/:userId', {
    schema: { params: {
      type: 'object', additionalProperties: false, required: ['sessionId', 'userId'],
      properties: { sessionId: { type: 'string', format: 'uuid' }, userId: { type: 'string', format: 'uuid' } }
    } }
  }, async (request, reply) => {
    let roomFingerprint;
    const result = await withTransaction(async (client) => {
      const access = await musicSessionAccess(client, request.params.sessionId, request.auth.userId);
      if (!access) return { status: 404, error: 'music_session_not_found' };
      if (!access.canManageDjs) return { status: 403, error: 'music_dj_management_required' };
      roomFingerprint = access.session.room_fingerprint;
      await client.query('UPDATE music_djs SET revoked_at = now() WHERE session_id = $1 AND user_id = $2 AND revoked_at IS NULL', [request.params.sessionId, request.params.userId]);
      await recordMusicEvent(client, request.params.sessionId, request.auth.userId, 'dj_remove', { userId: request.params.userId });
      return { status: 200 };
    });
    if (result.error) return reply.code(result.status).send({ error: result.error });
    return { session: await publicMusicSession(roomFingerprint, request.auth.userId) };
  });

  app.get('/tracks', async () => {
    const result = await getPool().query(
      `SELECT * FROM music_tracks
       WHERE status = 'ready'
       ORDER BY lower(title), lower(artist), created_at DESC
       LIMIT 500`
    );
    return { tracks: result.rows.map(publicTrack) };
  });

  app.post('/tracks/upload-request', {
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        required: ['sourceFilename', 'title', 'mimeType', 'byteSize'],
        properties: {
          sourceFilename: { type: 'string', minLength: 1, maxLength: 255 },
          title: { type: 'string', minLength: 1, maxLength: 160 },
          artist: { type: 'string', maxLength: 160 },
          album: { type: 'string', maxLength: 160 },
          artworkUrl: { anyOf: [
            { type: 'string', pattern: '^https://', maxLength: 1000 },
            { type: 'null' }
          ] },
          durationMs: { type: 'integer', minimum: 1, maximum: 86_400_000 },
          mimeType: { type: 'string', pattern: '^audio/', maxLength: 80 },
          byteSize: { type: 'integer', minimum: 1, maximum: 41_943_040 },
          contentSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }
        }
      }
    },
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    if (!(await catalogManager(request.auth.userId))) {
      return reply.code(403).send({ error: 'music_catalog_permission_required' });
    }

    const filename = safeAudioFilename(request.body.sourceFilename);
    if (!filename) return reply.code(400).send({ error: 'unsupported_audio_extension' });
    if (!request.body.title.trim()) return reply.code(400).send({ error: 'music_title_required' });

    const trackId = crypto.randomUUID();
    const storagePath = `tracks/${trackId}/${filename}`;
    let inserted;
    let retryingUpload = false;
    try {
      const result = await getPool().query(
        `INSERT INTO music_tracks
           (id, created_by, storage_path, source_filename, title, artist, album,
            artwork_url, duration_ms, mime_type, byte_size, content_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          trackId, request.auth.userId, storagePath, request.body.sourceFilename,
          request.body.title.trim(), request.body.artist?.trim() || '', request.body.album?.trim() || '',
          request.body.artworkUrl || null, request.body.durationMs || null,
          request.body.mimeType.toLowerCase(), request.body.byteSize,
          request.body.contentSha256?.toLowerCase() || null
        ]
      );
      inserted = result.rows[0];
    } catch (error) {
      if (error.code === '23505' && request.body.contentSha256) {
        const existing = await getPool().query(
          `SELECT * FROM music_tracks
            WHERE content_sha256 = $1 AND created_by = $2 AND status = 'uploading'
            ORDER BY created_at DESC LIMIT 1`,
          [request.body.contentSha256.toLowerCase(), request.auth.userId]
        );
        inserted = existing.rows[0];
        retryingUpload = Boolean(inserted);
      }
      if (!inserted && error.code === '23505') return reply.code(409).send({ error: 'music_track_already_exists' });
      if (!inserted) throw error;
    }

    const { data, error } = await getMusicBucket().createSignedUploadUrl(inserted.storage_path, { upsert: retryingUpload });
    if (error || !data?.token) {
      await getPool().query("UPDATE music_tracks SET status = 'failed', content_sha256 = NULL WHERE id = $1", [inserted.id]);
      storageFailure(app, 'createSignedUploadUrl', error);
      return reply.code(502).send({ error: 'music_storage_unavailable' });
    }

    return reply.code(201).send({
      track: publicTrack(inserted),
      upload: {
        bucket: getStorageConfig().musicBucket,
        path: inserted.storage_path,
        token: data.token,
        signedUrl: data.signedUrl,
        expiresIn: getStorageConfig().uploadExpiresIn
      }
    });
  });

  app.post('/tracks/:trackId/finalize', {
    schema: { params: uuidParams('trackId') }
  }, async (request, reply) => {
    if (!(await catalogManager(request.auth.userId))) {
      return reply.code(403).send({ error: 'music_catalog_permission_required' });
    }
    const current = await getPool().query('SELECT * FROM music_tracks WHERE id = $1', [request.params.trackId]);
    const track = current.rows[0];
    if (!track) return reply.code(404).send({ error: 'music_track_not_found' });
    if (track.status === 'ready') return { track: publicTrack(track) };
    if (track.status !== 'uploading') return reply.code(409).send({ error: 'music_track_not_uploading' });

    const separator = track.storage_path.lastIndexOf('/');
    const folder = track.storage_path.slice(0, separator);
    const filename = track.storage_path.slice(separator + 1);
    const { data, error } = await getMusicBucket().list(folder, { limit: 10, search: filename });
    if (error) {
      storageFailure(app, 'listUploadedTrack', error);
      return reply.code(502).send({ error: 'music_storage_unavailable' });
    }
    const object = data?.find((item) => item.name === filename && item.id);
    if (!object) return reply.code(409).send({ error: 'music_upload_not_found' });
    const uploadedSize = Number(object.metadata?.size || 0);
    if (uploadedSize !== Number(track.byte_size)) {
      return reply.code(409).send({ error: 'music_upload_size_mismatch' });
    }
    const uploadedMime = String(object.metadata?.mimetype || object.metadata?.contentType || '').toLowerCase();
    if (uploadedMime && !uploadedMime.startsWith('audio/')) {
      return reply.code(409).send({ error: 'music_upload_type_mismatch' });
    }

    const updated = await getPool().query(
      `UPDATE music_tracks SET status = 'ready', updated_at = now()
       WHERE id = $1 RETURNING *`,
      [track.id]
    );
    return { track: publicTrack(updated.rows[0]) };
  });

  app.get('/tracks/:trackId/stream', {
    schema: { params: uuidParams('trackId') },
    config: { rateLimit: { max: 120, timeWindow: '15 minutes' } }
  }, async (request, reply) => {
    const result = await getPool().query(
      "SELECT * FROM music_tracks WHERE id = $1 AND status = 'ready'",
      [request.params.trackId]
    );
    const track = result.rows[0];
    if (!track) return reply.code(404).send({ error: 'music_track_not_found' });
    const expiresIn = getStorageConfig().playbackExpiresIn;
    const { data, error } = await getMusicBucket().createSignedUrl(track.storage_path, expiresIn);
    if (error || !data?.signedUrl) {
      storageFailure(app, 'createSignedUrl', error);
      return reply.code(502).send({ error: 'music_storage_unavailable' });
    }
    return { track: publicTrack(track), signedUrl: data.signedUrl, expiresIn };
  });

  app.delete('/tracks/:trackId', {
    schema: { params: uuidParams('trackId') }
  }, async (request, reply) => {
    if (!(await catalogManager(request.auth.userId))) {
      return reply.code(403).send({ error: 'music_catalog_permission_required' });
    }
    const result = await getPool().query('SELECT * FROM music_tracks WHERE id = $1', [request.params.trackId]);
    const track = result.rows[0];
    if (!track) return reply.code(404).send({ error: 'music_track_not_found' });
    const { error } = await getMusicBucket().remove([track.storage_path]);
    if (error) {
      storageFailure(app, 'removeTrack', error);
      return reply.code(502).send({ error: 'music_storage_unavailable' });
    }
    await getPool().query(
      "UPDATE music_tracks SET status = 'disabled', content_sha256 = NULL, updated_at = now() WHERE id = $1",
      [track.id]
    );
    return reply.code(204).send();
  });

  app.get('/playlists', async (request) => {
    const result = await getPool().query(
      `SELECT p.*, u.handle_display AS owner_handle_display,
              count(pt.track_id)::int AS track_count,
              COALESCE(sum(t.duration_ms), 0)::bigint AS total_duration_ms
       FROM music_playlists p
       LEFT JOIN users u ON u.id = p.owner_id
       LEFT JOIN music_playlist_tracks pt ON pt.playlist_id = p.id
       LEFT JOIN music_tracks t ON t.id = pt.track_id AND t.status = 'ready'
       WHERE p.visibility = 'group' OR p.owner_id = $1
       GROUP BY p.id, u.handle_display
       ORDER BY p.updated_at DESC`,
      [request.auth.userId]
    );
    return { playlists: result.rows.map(publicPlaylist) };
  });

  app.post('/playlists', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          description: { type: 'string', maxLength: 500 },
          visibility: { type: 'string', enum: ['private', 'group'] }
        }
      }
    }
  }, async (request, reply) => {
    if (!request.body.name.trim()) return reply.code(400).send({ error: 'music_playlist_name_required' });
    const result = await getPool().query(
      `INSERT INTO music_playlists (owner_id, name, description, visibility)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [
        request.auth.userId, request.body.name.trim(), request.body.description?.trim() || '',
        request.body.visibility || 'group'
      ]
    );
    return reply.code(201).send({ playlist: publicPlaylist(result.rows[0]) });
  });

  app.get('/playlists/:playlistId', {
    schema: { params: uuidParams('playlistId') }
  }, async (request, reply) => {
    const access = await playlistAccess(request.params.playlistId, request.auth.userId);
    if (!access || !access.canRead) return reply.code(404).send({ error: 'music_playlist_not_found' });
    const tracks = await getPool().query(
      `SELECT t.*, pt.position, pt.added_at
       FROM music_playlist_tracks pt
       JOIN music_tracks t ON t.id = pt.track_id AND t.status = 'ready'
       WHERE pt.playlist_id = $1 ORDER BY pt.position`,
      [request.params.playlistId]
    );
    return {
      playlist: publicPlaylist(access.playlist),
      canEdit: access.canEdit,
      tracks: tracks.rows.map((row) => ({ ...publicTrack(row), position: row.position, addedAt: row.added_at }))
    };
  });

  app.patch('/playlists/:playlistId', {
    schema: {
      params: uuidParams('playlistId'),
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          description: { type: 'string', maxLength: 500 },
          visibility: { type: 'string', enum: ['private', 'group'] }
        }
      }
    }
  }, async (request, reply) => {
    const access = await playlistAccess(request.params.playlistId, request.auth.userId);
    if (!access?.canEdit) return reply.code(404).send({ error: 'music_playlist_not_found' });
    if (request.body.name !== undefined && !request.body.name.trim()) {
      return reply.code(400).send({ error: 'music_playlist_name_required' });
    }
    const current = access.playlist;
    const result = await getPool().query(
      `UPDATE music_playlists SET name = $2, description = $3, visibility = $4, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        current.id,
        request.body.name === undefined ? current.name : request.body.name.trim(),
        request.body.description === undefined ? current.description : request.body.description.trim(),
        request.body.visibility === undefined ? current.visibility : request.body.visibility
      ]
    );
    return { playlist: publicPlaylist(result.rows[0]) };
  });

  app.delete('/playlists/:playlistId', {
    schema: { params: uuidParams('playlistId') }
  }, async (request, reply) => {
    const access = await playlistAccess(request.params.playlistId, request.auth.userId);
    if (!access?.canEdit) return reply.code(404).send({ error: 'music_playlist_not_found' });
    await getPool().query('DELETE FROM music_playlists WHERE id = $1', [request.params.playlistId]);
    return reply.code(204).send();
  });

  app.post('/playlists/:playlistId/tracks', {
    schema: {
      params: uuidParams('playlistId'),
      body: {
        type: 'object', additionalProperties: false, required: ['trackId'],
        properties: { trackId: { type: 'string', format: 'uuid' } }
      }
    }
  }, async (request, reply) => {
    const access = await playlistAccess(request.params.playlistId, request.auth.userId);
    if (!access?.canEdit) return reply.code(404).send({ error: 'music_playlist_not_found' });
    try {
      await withTransaction(async (client) => {
        const track = await client.query("SELECT 1 FROM music_tracks WHERE id = $1 AND status = 'ready'", [request.body.trackId]);
        if (!track.rowCount) {
          const error = new Error('music_track_not_found'); error.statusCode = 404; throw error;
        }
        await client.query('SELECT id FROM music_playlists WHERE id = $1 FOR UPDATE', [request.params.playlistId]);
        const position = await client.query(
          'SELECT COALESCE(max(position), -1) + 1 AS next FROM music_playlist_tracks WHERE playlist_id = $1',
          [request.params.playlistId]
        );
        await client.query(
          `INSERT INTO music_playlist_tracks (playlist_id, track_id, position, added_by)
           VALUES ($1, $2, $3, $4)`,
          [request.params.playlistId, request.body.trackId, position.rows[0].next, request.auth.userId]
        );
      });
    } catch (error) {
      if (error.statusCode === 404) return reply.code(404).send({ error: error.message });
      if (error.code === '23505') return reply.code(409).send({ error: 'music_track_already_in_playlist' });
      throw error;
    }
    return reply.code(201).send({ added: true });
  });

  app.put('/playlists/:playlistId/tracks/order', {
    schema: {
      params: uuidParams('playlistId'),
      body: {
        type: 'object', additionalProperties: false, required: ['trackIds'],
        properties: {
          trackIds: {
            type: 'array', minItems: 1, maxItems: 500, uniqueItems: true,
            items: { type: 'string', format: 'uuid' }
          }
        }
      }
    }
  }, async (request, reply) => {
    const access = await playlistAccess(request.params.playlistId, request.auth.userId);
    if (!access?.canEdit) return reply.code(404).send({ error: 'music_playlist_not_found' });
    const reordered = await withTransaction(async (client) => {
      await client.query('SELECT id FROM music_playlists WHERE id = $1 FOR UPDATE', [request.params.playlistId]);
      const current = await client.query(
        'SELECT track_id::text FROM music_playlist_tracks WHERE playlist_id = $1 ORDER BY position',
        [request.params.playlistId]
      );
      const existing = current.rows.map((row) => row.track_id).sort();
      const requested = [...request.body.trackIds].sort();
      if (existing.length !== requested.length || existing.some((id, index) => id !== requested[index])) return false;
      await client.query('UPDATE music_playlist_tracks SET position = position + 1000000 WHERE playlist_id = $1', [request.params.playlistId]);
      for (const [position, trackId] of request.body.trackIds.entries()) {
        await client.query(
          'UPDATE music_playlist_tracks SET position = $3 WHERE playlist_id = $1 AND track_id = $2',
          [request.params.playlistId, trackId, position]
        );
      }
      await client.query('UPDATE music_playlists SET updated_at = now() WHERE id = $1', [request.params.playlistId]);
      return true;
    });
    if (!reordered) return reply.code(400).send({ error: 'music_playlist_order_mismatch' });
    return { reordered: true };
  });

  app.delete('/playlists/:playlistId/tracks/:trackId', {
    schema: { params: playlistTrackParams }
  }, async (request, reply) => {
    const access = await playlistAccess(request.params.playlistId, request.auth.userId);
    if (!access?.canEdit) return reply.code(404).send({ error: 'music_playlist_not_found' });
    const result = await getPool().query(
      'DELETE FROM music_playlist_tracks WHERE playlist_id = $1 AND track_id = $2',
      [request.params.playlistId, request.params.trackId]
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'music_playlist_track_not_found' });
    await getPool().query('UPDATE music_playlists SET updated_at = now() WHERE id = $1', [request.params.playlistId]);
    return reply.code(204).send();
  });
}
