# Prime Hax Social Server

Backend privado para las funciones sociales de Prime Hax.

## Estado inicial

- Registro cerrado mediante invitaciones personales de un solo uso.
- Contraseñas Argon2id.
- Dispositivos Ed25519 autorizados.
- Sesiones cortas y refresh tokens rotativos.
- PostgreSQL en Supabase con TLS verificado.
- API Fastify preparada para Render.

## Desarrollo local

```powershell
npm install
npm test
npm run db:check
npm start
```

La configuracion privada vive en `.env` y nunca debe subirse al repositorio.
Consultar `SETUP_GUIDE.md` para la puesta en marcha completa.
