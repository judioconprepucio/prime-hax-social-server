# Prime Hax Social Server

Backend privado para las funciones sociales de Prime Hax.

## Estado inicial

- Registro cerrado mediante invitaciones personales de un solo uso.
- Contraseñas Argon2id.
- Dispositivos Ed25519 autorizados.
- Sesiones cortas y refresh tokens rotativos.
- PostgreSQL en Supabase con TLS verificado.
- API Fastify preparada para Render.
- Catálogo musical privado en Supabase Storage con URLs firmadas.
- Playlists compartidas o privadas administradas desde Prime Hax.

## Desarrollo local

```powershell
npm install
npm test
npm run db:check
npm start
```

La configuracion privada vive en `.env` y nunca debe subirse al repositorio.
Consultar `SETUP_GUIDE.md` para la puesta en marcha completa.

## API musical

Todas las rutas requieren el access token privado de Prime Hax.

- `GET /v1/music/tracks`: catálogo disponible.
- `POST /v1/music/tracks/upload-request`: URL firmada de subida (developer/admin).
- `POST /v1/music/tracks/:trackId/finalize`: valida y publica una subida.
- `GET /v1/music/tracks/:trackId/stream`: URL privada temporal de reproducción.
- `GET|POST /v1/music/playlists`: listar o crear playlists.
- `GET|PATCH|DELETE /v1/music/playlists/:playlistId`: administrar una playlist.
- `POST|DELETE /v1/music/playlists/:playlistId/tracks`: modificar canciones.
- `PUT /v1/music/playlists/:playlistId/tracks/order`: reordenar canciones.

La clave `SUPABASE_SECRET_KEY` existe solamente en Render. El cliente recibe
tokens de subida y URLs de escucha con expiración, nunca la clave administrativa.
