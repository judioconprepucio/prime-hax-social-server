import path from 'node:path';

const catalogRoles = new Set(['developer', 'admin']);
const allowedExtensions = new Set(['.mp3', '.ogg', '.opus', '.wav', '.flac', '.m4a', '.mp4', '.aac', '.webm']);

export function canManageMusicCatalog(role) {
  return catalogRoles.has(role);
}

export function safeAudioFilename(value) {
  const basename = path.posix.basename(String(value || '').replaceAll('\\', '/')).normalize('NFKD');
  const extension = path.extname(basename).toLowerCase();
  if (!allowedExtensions.has(extension)) return null;
  const stem = basename.slice(0, -extension.length)
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180) || 'track';
  return `${stem}${extension}`;
}

export function publicTrack(row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    artworkUrl: row.artwork_url,
    durationMs: row.duration_ms,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function publicPlaylist(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerHandle: row.owner_handle_display ? `@${row.owner_handle_display}` : null,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    trackCount: Number(row.track_count || 0),
    durationMs: Number(row.total_duration_ms || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
