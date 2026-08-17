# Puesta en marcha de Prime Hax Social

Esta guía describe el despliegue gratuito inicial para un grupo privado de hasta
30 personas. No requiere abrir puertos ni mantener encendida la computadora del
administrador.

## 1. Componentes y cuentas externas

Crear estas cuentas personales:

1. **GitHub**: repositorio privado para el servidor.
2. **Supabase**: PostgreSQL gratuito.
3. **Render**: servidor Node.js gratuito.
4. **Discord Developer Portal**: solamente cuando se habilite el acceso con Discord.

Mantener el cliente Electron y el servidor en repositorios separados. El servidor
contendrá la lógica de autenticación; el repositorio del cliente nunca debe incluir
contraseñas de base de datos, secretos JWT o el secreto de Discord.

## 2. Crear PostgreSQL en Supabase

1. Crear un proyecto y elegir una región cercana a los jugadores.
2. Generar una contraseña de base de datos larga y guardarla en un administrador
   de contraseñas.
3. Abrir **SQL Editor** y ejecutar `database/schema.sql`.
4. En **Connect**, copiar la URL de **Session pooler**. Es la más compatible con
   un servidor persistente que necesite IPv4.
5. No colocar esa URL en Electron ni compartirla con los jugadores.

Durante el desarrollo, toda modificación de tablas debe vivir en un archivo de
migración versionado. No editar producción manualmente sin registrar el cambio.

## 3. Construir el servidor Node.js

El servidor tendrá inicialmente estos módulos:

- `auth`: invitaciones, registro, login, renovación y cierre de sesión.
- `devices`: desafíos firmados, aprobación y revocación de dispositivos.
- `profiles`: perfil público y presencia.
- `friends`: solicitudes, aceptación, eliminación y bloqueos.
- `chat`: conversaciones, mensajes y confirmaciones de lectura.
- `rooms`: invitaciones con enlace HaxBall y vencimiento.
- `admin`: crear invitaciones, revocar cuentas/dispositivos y revisar reportes.

Dependencias previstas:

- Fastify o Express para HTTPS/API.
- `pg` para PostgreSQL.
- `argon2` para contraseñas.
- `jose` para tokens de acceso firmados.
- WebSocket para eventos en tiempo real.
- Un validador de esquemas para toda entrada recibida.

El servicio debe escuchar en `0.0.0.0` y usar `process.env.PORT`.

## 4. Secretos del servidor

Generar valores aleatorios independientes y cargarlos únicamente en Render:

```text
NODE_ENV=production
DATABASE_URL=<Session pooler de Supabase>
JWT_ACCESS_SECRET=<secreto aleatorio de 32 bytes o más>
REFRESH_TOKEN_PEPPER=<secreto aleatorio diferente>
INVITE_CODE_PEPPER=<secreto aleatorio diferente>
DISCORD_CLIENT_ID=<se agrega más adelante>
DISCORD_CLIENT_SECRET=<se agrega más adelante>
DISCORD_REDIRECT_URI=<se agrega más adelante>
```

El archivo `.env` local debe estar ignorado por Git. Nunca imprimir estos valores
en logs, capturas o mensajes.

## 5. Publicar Node.js en Render

1. Subir el servidor a un repositorio privado de GitHub.
2. En Render elegir **New > Web Service** y conectar el repositorio.
3. Elegir el plan gratuito.
4. Configurar `npm ci` como Build Command y `npm start` como Start Command.
5. Cargar las variables anteriores en **Environment**.
   Para el módulo musical agregar también `SUPABASE_URL`,
   `SUPABASE_SECRET_KEY` y `SUPABASE_MUSIC_BUCKET=prime-hax-music`.
6. Desplegar y probar `GET /health`.
7. Guardar la URL HTTPS entregada por Render.

Cada `push` autorizado a la rama de producción puede generar un despliegue nuevo.

## 6. Invitaciones privadas y dispositivos

Flujo recomendado para cada amigo:

1. El administrador crea un código aleatorio de un solo uso, opcionalmente ligado
   a un `@handle`, con vencimiento de siete días.
2. Lo entrega por un canal privado. La base guarda solamente su hash.
3. El amigo instala Prime Hax, introduce el código, crea su handle y contraseña.
4. Registro y consumo del código ocurren en una única transacción PostgreSQL.
5. Electron genera un par de claves Ed25519 para esa instalación.
6. La clave privada se cifra localmente con `safeStorage`; solo la pública llega
   al servidor.
7. En cada login, el servidor envía un desafío aleatorio de corta duración. El
   dispositivo lo firma y el servidor verifica la firma antes de crear la sesión.

Un código global incrustado en el `.exe` no debe existir. Si alguien comparte el
instalador, no podrá crear una cuenta sin una invitación disponible. Si se filtra
una contraseña, el atacante también necesitará un dispositivo autorizado.

Cambiar de PC o reinstalar requiere aprobar un dispositivo nuevo. El administrador
puede revocar inmediatamente cuentas, sesiones y dispositivos.

## 7. Integrar el cliente Electron

La interfaz social será un documento local aislado, con el diseño de Prime Hax.
El renderer no hablará directamente con PostgreSQL ni recibirá secretos.

1. La UI llama una API mínima expuesta por `preload`.
2. El proceso principal de Electron realiza las solicitudes HTTPS al servidor.
3. El refresh token y la clave privada del dispositivo se protegen con
   `safeStorage` de Windows.
4. El access token permanece en memoria y vence rápidamente.
5. HaxBall continúa en su renderer remoto, separado del renderer social.

Pantallas de la primera versión:

- Bienvenida / introducir invitación.
- Crear cuenta / iniciar sesión.
- Dispositivo pendiente o revocado.
- Perfil.
- Amigos y solicitudes.
- Conversaciones.
- Invitaciones a partida.
- Panel administrador privado.

## 8. Configurar Discord más adelante

1. Crear una aplicación en Discord Developer Portal.
2. Copiar Client ID y generar Client Secret.
3. Agregar como redirect URL:
   `https://<servidor-render>/auth/discord/callback`.
4. Solicitar únicamente el scope `identify` para vincular identidad básica.
5. Guardar el Client Secret solo en Render.
6. Validar `state` y PKCE durante OAuth.
7. Asociar el ID verificado de Discord en `discord_accounts`.

Discord no sustituye la autorización del dispositivo. Una cuenta Discord vinculada
no puede ingresar desde una computadora nueva sin aprobación.

## 9. Pruebas antes de invitar al grupo

1. Código válido, vencido, revocado y reutilizado.
2. Registro simultáneo intentando consumir el mismo código.
3. Contraseña incorrecta y límite de intentos.
4. Dispositivo desconocido, revocado y desafío repetido.
5. Renovación y revocación de sesiones.
6. Bloqueos aplicados a mensajes, presencia e invitaciones.
7. Enlaces de sala inválidos o vencidos.
8. Reconexión después de que Render se despierte.
9. Eliminación segura de mensajes y conservación de reportes.
10. Restauración de una copia de seguridad de PostgreSQL.

La primera prueba debe hacerse con dos cuentas no administrativas. Después se
amplía gradualmente a cinco y finalmente al grupo completo.

## 10. Operación y migración futura

- Exportar periódicamente PostgreSQL con `pg_dump` y cifrar la copia.
- Actualizar Electron y dependencias del servidor.
- Revisar logs de seguridad sin registrar contraseñas o tokens.
- Revocar invitaciones no utilizadas.
- Limpiar desafíos y sesiones vencidos mediante una tarea programada.
- Mantener una cuenta administradora separada de la cuenta usada para jugar.

Como el esquema utiliza PostgreSQL estándar, una migración futura consiste en
crear otra base, importar el dump, cambiar `DATABASE_URL` y volver a desplegar.
