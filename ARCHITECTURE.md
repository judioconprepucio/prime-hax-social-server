# Prime Hax social backend

## Initial deployment

- Electron connects only to the public Node.js API over HTTPS/WSS.
- Node.js runs on Render and is the only component allowed to use `DATABASE_URL`.
- PostgreSQL runs on Supabase.
- Passwords are hashed on the server with Argon2id.
- Discord OAuth secrets and database credentials stay in server environment variables.
- The database schema is plain PostgreSQL so it can migrate to Railway, Render,
  Neon, AWS, or a self-hosted server without changing the data model.

## Authentication flow

1. The administrator creates a random, single-use invitation for one friend.
2. Registration accepts that invitation and a normalized handle without the
   visible `@` prefix. Redemption and user creation happen in one transaction.
3. The API validates uniqueness and hashes the password with Argon2id.
4. The client generates an Ed25519 device key pair. Only the public key is sent
   to the API; the private key is protected locally with Electron `safeStorage`.
5. Login verifies the password and a signature over a short-lived, one-use server
   challenge. A revoked or unknown device cannot open a session.
6. A successful login returns a short-lived access token plus a rotating
   refresh token.
7. Only a hash of each refresh token is stored in `refresh_sessions`.
8. Discord login maps the verified Discord user ID through `discord_accounts`,
   but it does not bypass device approval.

On reinstall or computer replacement, the administrator can approve a new device
using a new enrollment invitation. Recovery codes are one-use and stored only as
hashes. Global secrets embedded in the installer are explicitly avoided because
they can be extracted and shared.

## Social flow

- Friend requests are represented once in `friendships` using an ordered UUID pair.
- Direct conversations are represented once using the same ordered-pair approach.
- Messages and invitations are persisted before being broadcast over WebSocket.
- Blocking is enforced by the API for requests, messages, presence, and invites.
- Reports are retained for moderation even if the referenced message is removed.

## Monetization boundary

Core communication and gameplay integration remain free. Optional purchases grant
provider-neutral rows in `entitlements`. Suggested premium features are cosmetic:

- Profile themes, badges, animated frames, and additional avatar slots.
- Larger social customization limits.
- Supporter recognition and early access to experimental client features.

Do not sell competitive gameplay advantages, room priority, lower latency, or
security/privacy features. Payment-provider webhooks must be verified server-side
before creating or revoking an entitlement.
