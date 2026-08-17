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

export async function musicRoutes(app) {
  app.addHook('preHandler', requireAuth);

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
      if (error.code === '23505') return reply.code(409).send({ error: 'music_track_already_exists' });
      throw error;
    }

    const { data, error } = await getMusicBucket().createSignedUploadUrl(storagePath, { upsert: false });
    if (error || !data?.token) {
      await getPool().query("UPDATE music_tracks SET status = 'failed', content_sha256 = NULL WHERE id = $1", [trackId]);
      storageFailure(app, 'createSignedUploadUrl', error);
      return reply.code(502).send({ error: 'music_storage_unavailable' });
    }

    return reply.code(201).send({
      track: publicTrack(inserted),
      upload: {
        bucket: getStorageConfig().musicBucket,
        path: storagePath,
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
