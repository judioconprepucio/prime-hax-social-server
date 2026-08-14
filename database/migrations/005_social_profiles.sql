ALTER TABLE users
  ADD COLUMN IF NOT EXISTS banner_url text;

CREATE TABLE IF NOT EXISTS followers (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);

CREATE INDEX IF NOT EXISTS followers_followed_idx
  ON followers (followed_id, created_at DESC);

CREATE TABLE IF NOT EXISTS profile_media (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind varchar(10) NOT NULL CHECK (kind IN ('avatar', 'banner')),
  mime_type varchar(20) NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  content bytea NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

ALTER TABLE followers ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_media ENABLE ROW LEVEL SECURITY;
