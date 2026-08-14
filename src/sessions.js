import { securityConfig } from './config.js';
import { createAccessToken, hashWithPepper, randomToken } from './security.js';

export async function createSession(client, { userId, deviceId, deviceName, ipAddress, userAgent }) {
  const config = securityConfig();
  const refreshToken = randomToken(32);
  const tokenHash = hashWithPepper(refreshToken, config.refreshPepper);
  const expiresAt = new Date(Date.now() + config.refreshTokenDays * 86_400_000);

  await client.query(
    `INSERT INTO refresh_sessions
      (user_id, device_id, token_hash, device_name, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, deviceId, tokenHash, deviceName, ipAddress, userAgent, expiresAt]
  );

  return {
    accessToken: await createAccessToken(userId, deviceId),
    refreshToken,
    expiresInSeconds: config.accessTokenMinutes * 60
  };
}
