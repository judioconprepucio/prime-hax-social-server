-- Prime Hax social backend - PostgreSQL schema v1
-- Designed for a server-only database connection. The Electron client must never
-- receive DATABASE_URL or query these tables directly.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle citext NOT NULL UNIQUE,
  handle_display varchar(24) NOT NULL,
  password_hash text,
  display_name varchar(40) NOT NULL,
  avatar_url text,
  banner_url text,
  bio varchar(280) NOT NULL DEFAULT '',
  presence varchar(16) NOT NULL DEFAULT 'offline'
    CHECK (presence IN ('offline', 'online', 'away', 'busy', 'playing')),
  role varchar(16) NOT NULL DEFAULT 'member'
    CHECK (role IN ('member', 'admin')),
  is_disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  CHECK (handle::text ~ '^[a-z0-9][a-z0-9_-]{2,23}$'),
  CHECK (handle_display ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,23}$'),
  CHECK (password_hash IS NULL OR length(password_hash) >= 20)
);

CREATE TABLE discord_accounts (
  discord_user_id text PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  discord_username text NOT NULL,
  discord_avatar_hash text,
  linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  device_name varchar(120),
  ip_address inet,
  user_agent text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_sessions_user_active_idx
  ON refresh_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

-- Private-club enrollment. Codes are random, single-use secrets distributed by
-- the administrator. Only a SHA-256 hash of the code is persisted.
CREATE TABLE invitation_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  intended_handle citext,
  label varchar(120),
  granted_role varchar(16) NOT NULL DEFAULT 'member'
    CHECK (granted_role IN ('member', 'admin')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  redeemed_by uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  redeemed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(code_hash) = 64),
  CHECK (intended_handle IS NULL OR intended_handle::text ~ '^[a-z0-9][a-z0-9_-]{2,23}$'),
  CHECK ((redeemed_by IS NULL) = (redeemed_at IS NULL))
);

CREATE INDEX invitation_codes_available_idx
  ON invitation_codes (expires_at)
  WHERE redeemed_at IS NULL AND revoked_at IS NULL;

-- Each installation owns an Ed25519 key pair. The private key stays encrypted
-- on that computer; PostgreSQL stores only the public key and its fingerprint.
CREATE TABLE trusted_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name varchar(120) NOT NULL,
  public_key text NOT NULL,
  fingerprint text NOT NULL,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);

CREATE INDEX trusted_devices_user_active_idx
  ON trusted_devices (user_id, last_used_at DESC)
  WHERE revoked_at IS NULL;

-- Short-lived, one-use nonces prevent a captured device signature from being
-- replayed during a later login attempt.
CREATE TABLE device_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES trusted_devices(id) ON DELETE CASCADE,
  nonce_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(nonce_hash) = 64)
);

CREATE INDEX device_challenges_expiry_idx ON device_challenges (expires_at);

CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(code_hash) = 64)
);

CREATE TABLE security_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type varchar(80) NOT NULL,
  device_id uuid REFERENCES trusted_devices(id) ON DELETE SET NULL,
  ip_address inet,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX security_audit_user_timeline_idx
  ON security_audit_events (user_id, created_at DESC);

-- Store each friendship once, with the smaller UUID first.
CREATE TABLE friendships (
  user_low_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  PRIMARY KEY (user_low_id, user_high_id),
  CHECK (user_low_id < user_high_id),
  CHECK (requested_by IN (user_low_id, user_high_id))
);

CREATE INDEX friendships_high_user_idx ON friendships (user_high_id, status);
CREATE INDEX friendships_requester_idx ON friendships (requested_by, status);

CREATE TABLE followers (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);

CREATE INDEX followers_followed_idx ON followers (followed_id, created_at DESC);

CREATE TABLE profile_media (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind varchar(10) NOT NULL CHECK (kind IN ('avatar', 'banner')),
  mime_type varchar(20) NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  content bytea NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE user_blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind varchar(16) NOT NULL DEFAULT 'direct'
    CHECK (kind IN ('direct', 'group', 'system')),
  direct_user_low_id uuid REFERENCES users(id) ON DELETE CASCADE,
  direct_user_high_id uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'direct' AND direct_user_low_id IS NOT NULL AND direct_user_high_id IS NOT NULL
      AND direct_user_low_id < direct_user_high_id)
    OR
    (kind <> 'direct' AND direct_user_low_id IS NULL AND direct_user_high_id IS NULL)
  )
);

CREATE UNIQUE INDEX conversations_direct_pair_idx
  ON conversations (direct_user_low_id, direct_user_high_id)
  WHERE kind = 'direct';

CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz,
  muted_until timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX conversation_members_user_idx
  ON conversation_members (user_id, conversation_id);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body varchar(2000) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  CHECK (length(btrim(body)) > 0)
);

CREATE INDEX messages_conversation_timeline_idx
  ON messages (conversation_id, created_at DESC, id DESC);

CREATE TABLE room_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  receiver_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_url text NOT NULL,
  room_name varchar(160),
  status varchar(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CHECK (sender_id <> receiver_id),
  CHECK (room_url ~ '^https://(www\.)?haxball\.com/play\?c=')
);

CREATE INDEX room_invites_receiver_pending_idx
  ON room_invites (receiver_id, created_at DESC)
  WHERE status = 'pending';

CREATE TABLE user_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  reason varchar(80) NOT NULL,
  details varchar(1000),
  status varchar(16) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (reporter_id <> reported_user_id)
);

-- Provider-neutral premium access. A future payment integration grants an
-- entitlement; application features never depend directly on Stripe/Discord/etc.
CREATE TABLE entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature_key varchar(80) NOT NULL,
  provider varchar(32) NOT NULL,
  provider_reference text,
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX entitlements_user_active_idx
  ON entitlements (user_id, feature_key, expires_at)
  WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER conversations_set_updated_at
BEFORE UPDATE ON conversations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE refresh_sessions
  ADD COLUMN device_id uuid REFERENCES trusted_devices(id) ON DELETE CASCADE;

CREATE INDEX refresh_sessions_device_active_idx
  ON refresh_sessions (device_id, expires_at)
  WHERE revoked_at IS NULL;

-- Supabase exposes the public schema through its Data API. Prime Hax uses a
-- server-only PostgreSQL connection, so no browser/client role gets direct table
-- access. The database owner used by the Node.js backend can still operate them.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE discord_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE trusted_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE followers ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
