-- Prime Hax synchronized room music.
-- Audio bytes live in the private Supabase Storage bucket; PostgreSQL stores
-- catalog metadata, playlists, room state, permissions and the durable queue.

CREATE TABLE IF NOT EXISTS music_tracks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  storage_path text NOT NULL UNIQUE,
  source_filename varchar(255) NOT NULL,
  title varchar(160) NOT NULL,
  artist varchar(160) NOT NULL DEFAULT '',
  album varchar(160) NOT NULL DEFAULT '',
  artwork_url text,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms > 0),
  mime_type varchar(80) NOT NULL CHECK (mime_type LIKE 'audio/%'),
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 41943040),
  content_sha256 char(64),
  status varchar(16) NOT NULL DEFAULT 'uploading'
    CHECK (status IN ('uploading', 'ready', 'failed', 'disabled')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS music_tracks_content_sha256_idx
  ON music_tracks (content_sha256)
  WHERE content_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS music_tracks_catalog_idx
  ON music_tracks (status, created_at DESC);

CREATE TABLE IF NOT EXISTS music_playlists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name varchar(120) NOT NULL,
  description varchar(500) NOT NULL DEFAULT '',
  visibility varchar(16) NOT NULL DEFAULT 'group'
    CHECK (visibility IN ('private', 'group')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(btrim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS music_playlists_owner_idx
  ON music_playlists (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS music_playlist_tracks (
  playlist_id uuid NOT NULL REFERENCES music_playlists(id) ON DELETE CASCADE,
  track_id uuid NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (playlist_id, track_id),
  UNIQUE (playlist_id, position)
);

CREATE INDEX IF NOT EXISTS music_playlist_tracks_order_idx
  ON music_playlist_tracks (playlist_id, position);

CREATE TABLE IF NOT EXISTS music_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_fingerprint char(64) NOT NULL,
  room_name varchar(160),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  playlist_id uuid REFERENCES music_playlists(id) ON DELETE SET NULL,
  current_track_id uuid REFERENCES music_tracks(id) ON DELETE SET NULL,
  playback_state varchar(16) NOT NULL DEFAULT 'stopped'
    CHECK (playback_state IN ('stopped', 'playing', 'paused')),
  track_started_at timestamptz,
  paused_position_ms integer NOT NULL DEFAULT 0 CHECK (paused_position_ms >= 0),
  shuffle_enabled boolean NOT NULL DEFAULT false,
  repeat_mode varchar(16) NOT NULL DEFAULT 'off'
    CHECK (repeat_mode IN ('off', 'track', 'playlist')),
  auto_dj_enabled boolean NOT NULL DEFAULT true,
  master_volume smallint NOT NULL DEFAULT 100 CHECK (master_volume BETWEEN 0 AND 100),
  state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (room_fingerprint ~ '^[0-9a-f]{64}$'),
  CHECK (
    (playback_state = 'playing' AND current_track_id IS NOT NULL AND track_started_at IS NOT NULL)
    OR playback_state <> 'playing'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS music_sessions_active_room_idx
  ON music_sessions (room_fingerprint)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS music_sessions_owner_idx
  ON music_sessions (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS music_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES music_sessions(id) ON DELETE CASCADE,
  track_id uuid NOT NULL REFERENCES music_tracks(id) ON DELETE CASCADE,
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  position bigint NOT NULL CHECK (position >= 0),
  status varchar(16) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'playing', 'played', 'skipped', 'removed')),
  added_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (session_id, position)
);

CREATE INDEX IF NOT EXISTS music_queue_session_status_idx
  ON music_queue (session_id, status, position);

CREATE TABLE IF NOT EXISTS music_djs (
  session_id uuid NOT NULL REFERENCES music_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (session_id, user_id)
);

CREATE INDEX IF NOT EXISTS music_djs_active_user_idx
  ON music_djs (user_id, session_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS music_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES music_sessions(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type varchar(48) NOT NULL,
  state_version bigint NOT NULL CHECK (state_version >= 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (event_type ~ '^[a-z][a-z0-9_]{1,47}$')
);

CREATE INDEX IF NOT EXISTS music_events_session_timeline_idx
  ON music_events (session_id, id DESC);

CREATE TRIGGER music_tracks_set_updated_at
BEFORE UPDATE ON music_tracks
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER music_playlists_set_updated_at
BEFORE UPDATE ON music_playlists
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER music_sessions_set_updated_at
BEFORE UPDATE ON music_sessions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The Node.js backend is the only trusted database caller. The Electron app
-- never receives a database credential or the Supabase secret key.
ALTER TABLE music_tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE music_playlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE music_playlist_tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE music_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE music_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE music_djs ENABLE ROW LEVEL SECURITY;
ALTER TABLE music_events ENABLE ROW LEVEL SECURITY;
