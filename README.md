<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode (compila antes: ejecuta dist/main.js)
$ npm run build && npm run start:prod
```

Requiere Node 22 o superior (`.nvmrc` y `engines` en `package.json`; con nvm:
`nvm use`). `nest build` compila solo `src/` (`tsconfig.build.json`), así que la
entrada queda en `dist/main.js`; `prisma/seed*.ts` no se compilan: se ejecutan
con ts-node (`npx prisma db seed`, `npm run seed:demo`), así que en el entorno
de despliegue hacen falta las devDependencies para sembrar. El puerto se lee de
`PORT` (default 3000). Sondas de salud (ver «Observabilidad»):
`GET /api/v1/health` (liveness) y `GET /api/v1/health/ready` (readiness).

## Local setup

1. Instalar dependencias:
   ```bash
   npm install
   ```
2. Configurar variables de entorno (`.env`, ver `.env.test` para el entorno de tests) con `DATABASE_URL`/`DIRECT_URL` apuntando a Postgres.
   Copia `.env.example` a `.env` y **genera los secretos JWT** (uno distinto
   para cada variable; también en `.env.test`):
   ```bash
   openssl rand -hex 32   # → JWT_ACCESS_SECRET
   openssl rand -hex 32   # → JWT_REFRESH_SECRET
   ```
   La API valida la configuración al arrancar y **no arranca** si
   `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` faltan, tienen menos de 32
   caracteres, son iguales entre sí o son valores conocidos de ejemplo
   (`change-me…`, `changeme`, `secret`…); el error dice qué variable corregir
   sin mostrar su valor. Con `NODE_ENV=production` además exige
   `CORS_ROOT_DOMAIN`, `TENANT_BASE_DOMAINS` y `FILES_PUBLIC_BASE_URL` (https,
   sin dominios locales), rechaza los secretos ficticios de CI (`solo-test…`) y
   las contraseñas de base de datos de ejemplo (`changeme`, `dentalix_app`…).
3. Aplicar las migraciones:
   ```bash
   npx prisma migrate deploy
   ```
4. Sembrar datos de referencia (monedas, países, ciudades):
   ```bash
   npx prisma db seed
   ```
   Idempotente: las ciudades solo se siembran una vez (los ids son estables).
5. (Opcional) Sembrar la **clínica demo** para probar todo el producto en local:
   ```bash
   npm run seed:demo            # crea la demo si no existe
   npm run seed:demo -- --reset # la reconstruye con fechas relativas a hoy
   ```
   Requiere los pasos 3 y 4 (usa el catálogo de monedas y las ciudades). Crea
   "Clínica Demo" con subdominio `demo` — en local `demo.localhost` resuelve al
   tenant por `Tenant.subdomain` (`localhost` está en `TENANT_BASE_DOMAINS`), sin
   necesidad de `TenantDomain` — y la deja lista en **http://demo.localhost:3001**
   (web en 3001, API en 3000). Al terminar imprime las credenciales; todos los
   usuarios comparten la contraseña `DemoDentalix2026!`:

   | Rol       | Email                         |
   |-----------|-------------------------------|
   | ADMIN     | `admin@demo.dentalix.app`     |
   | DENTIST   | `dentista@demo.dentalix.app`  |
   | DENTIST   | `dentista2@demo.dentalix.app` |
   | RECEPTION | `recepcion@demo.dentalix.app` |
   | ASSISTANT | `asistente@demo.dentalix.app` |

   Contenido: 2 sedes con horario (la principal con el horario por defecto del
   registro; "Sede Norte" con el suyo), catálogo por defecto con tarifas en COP,
   25 pacientes ficticios (correos `@example.com`) con historias clínicas,
   evoluciones (una corregida con una adenda — DX-038) y odontograma (un hallazgo anulado con motivo y una paciente infantil con dentición mixta, registros temporales y de otro origen — DX-120), 5 tipos de cita con duración y color (DX-121), ~90 citas desde el lunes de la semana pasada hasta
   el sábado de la próxima en distintos estados (las de valoración, limpieza, endodoncia, urgencia y ortodoncia con su tipo), planes de tratamiento en todos
   sus estados (con un presupuesto en borrador con descuentos, listo para
   presentar, y otro aceptado con la firma del paciente — DX-012; y dos opciones A/B de Carolina Duque —implante o puente— presentadas hace 9 días y sin cita futura, que salen en «Presupuestos por seguir» — DX-040), abonos en COP de los últimos 60 días en ambas sedes, un plan de
   pagos con cuotas e inventario por sede con ítems bajo el stock mínimo.

   - **Idempotencia**: si el tenant `demo` ya existe, no hace nada (solo vuelve a
     imprimir las credenciales). `--reset` retira la demo anterior **en blando**
     (tenant, membresías y usuarios `@demo.dentalix.app` con `deletedAt`, como el
     resto del producto) y la crea de nuevo; úsalo cuando la agenda "envejezca".
     Si una corrida falla a medias, la demo incompleta se retira sola.
   - **Nunca toca lo ajeno**: un tenant `demo` que no creó el seed (sin
     `admin@demo.dentalix.app` como ADMIN vivo) aborta la corrida, con o sin
     `--reset`; y si algún usuario `@demo.dentalix.app` es miembro vivo de otra
     clínica, tampoco se retira nada.
   - **Determinista**: sin azar; todo depende solo de la fecha de hoy (hora de
     Bogotá, UTC-5 fijo).
   - **Conexión**: no usa `DIRECT_URL`. Levanta la app (`AppModule`) y escribe con
     los mismos casos de uso que la API (registro, invitación + aceptación, sedes,
     horarios, pacientes, planes, abonos, plan de pagos, inventario), por
     `DATABASE_URL` (rol `dentalix_app`). Las tablas de clínica se escriben con
     `app.current_tenant` fijado, así que la RLS garantiza que nada cae fuera del
     tenant demo; las únicas escrituras sin tenant son a las tablas globales
     `tenants` y `users`, acotadas al tenant y a los correos demo. Las citas
     pasadas usan `CreateAppointmentUseCase.registerHistorical`: las mismas
     validaciones (pertenencia, horario, solapes) salvo "no en el pasado".
   - **Solo local**: carga `.env` y se niega a correr con `NODE_ENV=production`
     (sin excepción) o si el host de `DATABASE_URL` no es
     `localhost`/`127.0.0.1`/`::1`; esto último se puede levantar con
     `ALLOW_DEMO_SEED=1` para una base de pruebas desechable.

## Observabilidad

- **Request id**: cada respuesta lleva `X-Request-Id`. Si el cliente (o el
  balanceador) manda uno válido —8 a 128 caracteres `A-Z a-z 0-9 . _ : -`— se
  respeta; si no, o si es inválido (espacios, comillas, saltos de línea: así
  no puede inyectar líneas en el log), la API genera un UUID. Va en cada línea
  de log de la petición y en el cuerpo de los errores 5xx (`requestId`), para
  que soporte encuentre el error en el log a partir de lo que ve el usuario.
- **Log estructurado** (sin dependencias, `src/shared/observability`): una
  línea por evento a stdout (errores a stderr). Variables:

  | Variable     | Valores                                   | Default                         |
  |--------------|-------------------------------------------|---------------------------------|
  | `LOG_LEVEL`  | `silent`, `error`, `warn`, `info`, `debug` | `info` (`silent` con `NODE_ENV=test`) |
  | `LOG_FORMAT` | `json`, `pretty`                           | `json`                          |

  En producción se deja `json` (lo que leen los recolectores); en desarrollo
  `LOG_FORMAT=pretty` da líneas legibles. Un valor desconocido aborta el
  arranque. En los e2e, `test/setup-e2e.ts` fija `LOG_LEVEL=silent` si no
  viene de la línea de comandos (así un `LOG_LEVEL` del `.env` de desarrollo
  no ensucia la salida). Ese nivel solo afecta a las suites que montan la app
  con `test/support/create-e2e-app.ts` (= `configureApp`, igual que
  `main.ts`); para ver su log: `LOG_LEVEL=debug npx dotenv -e .env.test --
  jest --config ./test/jest-e2e.json test/<suite>.e2e-spec.ts`. Las suites
  que aún montan la app a mano usan el logger por defecto de Nest y no
  escriben líneas de acceso. `test/observability.e2e-spec.ts` lee el log
  desde un destino en memoria.
- **Log de acceso**: una línea por petición, al cerrarse la respuesta:

  ```json
  {"method":"GET","route":"/api/v1/patients/:id","status":200,"durationMs":12.873,"tenantId":"6f0c…","userId":"a41b…","time":"2026-10-16T14:03:11.412Z","level":"info","context":"Access","requestId":"3f1c2b9e-8a4d-4c1e-9f0a-1b2c3d4e5f60","msg":"GET /api/v1/patients/:id 200"}
  ```

  Los campos son una lista cerrada: la ruta es la **plantilla** (nunca la URL
  con ids ni la query de búsqueda) y no se registran cuerpos, cabeceras,
  nombres ni datos clínicos (Ley 1581 / RGPD). Además, cualquier campo
  estructurado pasa por una redacción que oculta `Authorization`, `Cookie`,
  `Set-Cookie` y claves con `password`, `token`, `secret` o `apiKey`.
- **Errores 5xx**: al cliente solo le llega su cuerpo (genérico si el error
  no estaba controlado) con el `requestId`; nunca el stack ni el mensaje
  interno. En el log:
  - **error no controlado** → una línea `error` con request id, método, ruta
    plantilla, tipo del error y los marcos `at …` del stack, **sin el
    mensaje**: el de Prisma (`PrismaClientValidationError`, `RustPanicError`,
    `InitializationError`…) reproduce la query con sus argumentos, y uno
    propio puede llevar lo que el código interpoló. El tipo, el marco que lo
    lanzó y el request id bastan para localizarlo.
  - **`HttpException` 5xx lanzada a propósito** (p. ej. el 503 de la
    readiness) → una línea `warn` sin stack, con el tipo de su `cause`.
  - **Prisma Known/Unknown** → `PrismaExceptionFilter`: su mensaje sin el
    `DETAIL` de Postgres (lleva la fila con datos del paciente).
- **Sondas** (públicas, fuera del rate limit y sin resolver tenant):
  - `GET /api/v1/health` → `200 {"status":"ok"}` siempre que el proceso viva;
    no toca la base, para que una caída de Postgres no reinicie la API.
  - `GET /api/v1/health/ready` → `200 {"status":"ok","database":"up"}` si
    `SELECT 1` responde en menos de 2 s; si no, `503
    {"statusCode":503,"status":"unavailable","database":"down","requestId":…}`
    para que el balanceador saque la instancia de rotación. Cada fallo deja
    una sola línea `warn` con la causa (`DatabaseTimeoutError`,
    `PrismaClientInitializationError`…).

## Auditoría (DX-009)

Registro de quién vio o cambió datos clínicos y financieros (Ley 1581, Res.
1995/1999, RGPD), en la tabla `audit_events` (módulo `src/modules/audit`).

- **Qué se audita**: los endpoints marcados con `@Audit({ action, resource,
  resourceId?, patient? })`: pacientes, historia clínica, evoluciones,
  odontograma, periodontograma, consentimientos, autorizaciones de datos,
  recetas, planes de tratamiento (presupuesto y aceptación), abonos y
  anulaciones, planes de cuotas, estado de cuenta y el login (correcto y
  fallido). La lista exacta la fija `src/modules/audit/audit-coverage.spec.ts`.
  No se audita la búsqueda `GET /patients` ni la propia lectura del registro.
- **Un evento por petición** que termina bien (una sola escritura, nunca N):
  actor, rol, acción, recurso, paciente, sede activa, request id
  (`X-Request-Id`, DX-023), IP y user agent. Una petición que falla (404,
  403...) no deja evento, salvo el login fallido (401), que guarda el miembro
  si el email es de la clínica y ningún actor si no.
- **Cuándo**: justo después del éxito del handler y antes de responder, en su
  propia transacción. Si la escritura falla, la petición (lectura o escritura)
  sigue y queda una línea `error` en el log con el request id.
- **Sin contenido clínico**: la metadata solo admite nombres de campo, ids de la
  ruta y códigos (`sanitizeAuditMetadata`); ni texto de la historia, ni
  alergias, ni diagnósticos, ni firmas, ni importes.
- **Append-only**: el rol de la app no tiene UPDATE, DELETE, TRUNCATE ni
  TRIGGER en la tabla ni en sus particiones (42501, DX-102); además un trigger
  rechaza UPDATE siempre y DELETE/TRUNCATE salvo a un superusuario (limpieza
  de las bases de test). RLS forzada por tenant en el padre y en cada
  partición. Sin claves foráneas, a propósito: es evidencia y no bloquea ni
  sigue en cascada el borrado de lo que referencia.
- **Particionada por mes** (`occurredAt`, UTC; DX-102): `audit_events_pYYYYMM`
  más `audit_events_default` de seguridad (un evento de un mes sin partición
  no rompe la petición). La migración crea 24 meses por delante y la API
  reasegura `AUDIT_PARTITIONS_MONTHS_AHEAD` (default 12) al arrancar y cada
  día con `audit_events_ensure_partitions`, idempotente. Prisma 6 no modela
  particiones: viven solo en SQL y `prisma migrate diff` las ignora. En una BD
  cuyo rol de la app no se llame `dentalix_app`, concédele a mano `SELECT,
  INSERT` en `audit_events` y `EXECUTE` en `audit_events_ensure_partitions`.
  Si `audit_events_default` llega a tener filas (horizonte sin asegurar),
  la función avisa con un WARNING y no crea ese mes: muévelas como owner
  (DETACH de DEFAULT, crear el mes, copiar, volver a adjuntar) en una ventana.
- **Retención**: `AUDIT_RETENTION_MONTHS` (default y mínimo 180 meses, 15
  años, como la historia clínica). `npm run audit:purge -- --dry-run` lista y
  `npm run audit:purge` hace DETACH + DROP de las particiones COMPLETAS más
  antiguas que la retención, con DIRECT_URL (owner): la app no puede ejecutar
  `audit_events_purge`. Archiva antes en frío lo que se vaya a borrar.
- **Benchmark**: `docs/perf/audit-events-bench.sql` (1,5 M eventos, EXPLAIN
  como `dentalix_app` con RLS).
- **Consulta**: `GET /api/v1/audit-events` (solo ADMIN), filtros `patientId`,
  `actorUserId`, `action`, `resourceType`, `from`/`to` (instantes ISO; por
  defecto los últimos 30 días, como mucho 366), paginado por cursor
  (`nextCursor`, `limit` ≤ 100).

## Email transaccional (DX-088)

Módulo `src/modules/notifications/email` (hexagonal, como el resto):

- **Puerto** `Mailer.send({to, subject, html, text})` con dos adaptadores:
  `ConsoleMailer` (desarrollo y test: una línea de log `email.console` con el
  destinatario **enmascarado** y el tamaño del mensaje; nunca el cuerpo, que
  lleva el enlace con el token) y `SmtpMailer` (nodemailer; cualquier
  proveedor con SMTP). Se elige con `MAIL_TRANSPORT=console|smtp`.
- **Encolar**: `EmailOutbox.enqueue({tenantId?, to, template, vars, locale,
  referenceId?})` renderiza la plantilla con la marca de la clínica (nombre, y
  logo si es una URL http(s)), cifra el mensaje y lo deja `PENDING` en
  `email_outbox`. Devuelve en cuanto la fila está guardada: **la petición
  nunca espera al proveedor** (y un fallo del proveedor nunca es un 500).
- **Plantillas** en español, HTML sencillo + texto, con todas las variables
  escapadas: `invitation` (en uso), `password-reset`, `email-verify` y
  `appointment-reminder` (listas para DX-010, DX-029 y DX-026).
- **Despachador en proceso** (`EmailDispatcher`, hasta la cola de DX-085): se
  despierta tras cada encolado y barre cada `MAIL_DISPATCH_INTERVAL_MS`
  (default 30 s; 0 lo apaga, y es 0 con `NODE_ENV=test`). Reclama filas con
  `FOR UPDATE SKIP LOCKED` y un arriendo de 5 min, así que con varias réplicas
  ninguna fila se envía dos veces y la de una réplica caída se recupera. 3
  intentos con backoff exponencial (`MAIL_RETRY_BASE_MS`, 1 min y 2 min por
  defecto); tras el 3.er fallo queda `FAILED`. Al apagar (SIGTERM,
  `enableShutdownHooks`) deja de barrer y espera la tanda en vuelo.
- **Datos personales**: `email_outbox` nunca guarda el email ni el token en
  claro: `toHash` (HMAC-SHA256), `toMasked` (`an***@dominio`) y el mensaje
  cifrado con AES-256-GCM (`MAIL_ENCRYPTION_KEY`), que se borra al quedar
  `SENT` o `FAILED` (un `CHECK` de la tabla lo garantiza). `lastError` guarda
  solo el tipo y el código del proveedor, nunca su mensaje.
- **RLS**: la tabla lleva la política estándar por clínica. El despachador, que
  trabaja para todas a la vez, y los emails de plataforma (`tenantId` NULL)
  pasan por tres funciones `SECURITY DEFINER` de la migración
  `20261017120000_email_outbox`, concedidas explícitamente a `dentalix_app`.
  Desde DX-113 son del rol NOLOGIN `dentalix_email_dispatcher` (sin
  BYPASSRLS, con una política permisiva en `email_outbox` solo para él), no
  del owner de las migraciones, que en un Postgres gestionado no se salta la
  RLS (ver «Despliegue: roles de la BD»). El arriendo de un reclamo se acota a 900 s y el cierre de
  un intento solo vale para ESE intento (fencing por `attempts`). Si el rol de la app se crea después de migrar, concédele
  `EXECUTE` sobre `email_outbox_claim`, `email_outbox_settle` y
  `email_outbox_enqueue_platform`.
- **Producción**: la API **no arranca** sin `MAIL_TRANSPORT="smtp"`,
  `SMTP_URL` (smtp:// o smtps://, sin `?query`), `MAIL_FROM` y
  `MAIL_ENCRYPTION_KEY` (`openssl rand -hex 32`), ni con
  `MAIL_DISPATCH_INTERVAL_MS` < 5000. Tampoco arranca si el despachador no
  tiene acceso (el rol de la app no puede ejecutar las funciones o su owner no
  ve todas las filas de `email_outbox`): es un fallo de despliegue permanente, no un corte de la BD,
  así que se trata como la configuración inválida y no como la readiness
  (DX-023). Fuera de producción solo deja un `error`
  `email.dispatcher_misconfigured`. Ver `.env.example`.
- **SMTP**: TLS obligatorio (smtps://, o STARTTLS exigido en smtp://), TLS ≥
  1.2 y certificado verificado; la query de `SMTP_URL` se ignora. El
  transporte se cierra al apagar.
- **Anti-abuso** (cualquiera puede registrar una clínica e invitar a
  cualquier correo): `POST /staff/invitations` y `/:id/resend` llevan la
  política de rate limit `invitation-email` (por clínica + usuario, 10/min,
  `RATE_LIMIT_INVITATION_EMAIL_*`) y, contados en la BD (valen entre
  réplicas), un enfriamiento de 60 s y un máximo de 5 emails/24 h al mismo
  destinatario de la clínica, y 50 emails/24 h por clínica
  (`MAIL_RECIPIENT_COOLDOWN_SECONDS`, `MAIL_RECIPIENT_DAILY_LIMIT`,
  `MAIL_TENANT_DAILY_LIMIT`). Al pasarlos: 429 con el motivo en español, sin
  tocar la invitación (el enlace vigente sigue valiendo). `fullName` ≤ 120 y
  `email` ≤ 254 caracteres.

**Invitaciones**: `POST /staff/invitations` encola el email `invitation` con
el enlace `<protocolo>://<host de la clínica>/invitacion/<token>` (el host con
el que llegó la petición, validado; el protocolo sale de
`PUBLIC_WEB_PROTOCOL`). Desde DX-029 **el token ya no se devuelve al ADMIN**:
solo viaja en el email, así quien lo abre demuestra que controla ese correo.
`POST /staff/invitations/:id/resend` (solo ADMIN) regenera
el token —el anterior deja de servir— y reinicia los 7 días; revocar o
reenviar cancela el email que siguiera pendiente con el enlace viejo.
`GET /staff/directory` devuelve en cada invitación `emailDelivery`
(`PENDING` | `SENT` | `FAILED` | `null`).

## Cuentas sin enumeración ni pre-secuestro (DX-029)

La tabla `users` es global: nada público ni de ADMIN debe revelar si un email
arbitrario tiene cuenta, ni dejar que alguien se apropie de un email ajeno.

- **Registro** `POST /auth/register` → **siempre 202** `{ message }`, el mismo
  cuerpo exista o no el email, y no crea nada todavía. El hash argon2 de la
  contraseña se calcula en los dos casos antes de responder; la búsqueda del
  email y el envío corren en segundo plano (ni cuerpo ni tiempo delatan nada).
  Email nuevo → registro pendiente (`pending_registrations`, solo hash del
  token y de la contraseña, uno por email, 24 h) y email `email-verify` con
  `<protocolo>://<host>/register/verificar/<token>`. Email ya registrado → no
  se guarda nada y el titular recibe `registration-notice` («alguien intentó
  registrar una clínica con tu correo…»). 409 solo si el **subdominio** está
  ocupado (es público). `POST /auth/register/verify { token, password }`
  (la contraseña elegida al registrarse: quien no pidió el alta no puede
  confirmarla con un clic) crea la clínica, su sede y su dueño con
  `emailVerifiedAt` puesto (201 `{ tenantId, userId, subdomain }`; 404
  genérico si el enlace no vale, ya se usó o la contraseña no coincide, sin
  distinguirlos; 410 caducado; 409 subdominio o email tomados entretanto). El enlace solo apunta a un host de
  la plataforma (`TENANT_BASE_DOMAINS` o un subdominio suyo): un registro que
  llega con otro `Host`/`X-Forwarded-Host` (inyectado, o el dominio propio de
  una clínica) recibe 400 «Host inválido» y no se envía nada. Los pendientes
  caducados se purgan al guardar uno nuevo.
- **En local sin SMTP**: arranca la API con `MAIL_TRANSPORT=file
  MAIL_FILE_DIR=./.mail`; cada email (verificación del registro, invitación,
  aviso) queda como JSON en esa carpeta y de ahí se copia el enlace. Con
  `console` (el default) el enlace NO se ve: el log no lleva el cuerpo.
- **Invitaciones**: el token solo va por email; `GET /public/invitations/:token`
  ya no trae `userExists` sino `requiresCurrentPassword` (true solo para una
  cuenta **verificada**), que solo ve quien recibió el correo. Aceptar:
  - sin cuenta → se crea con `emailVerifiedAt`;
  - cuenta verificada → exige su contraseña (401 en español; si la olvidó,
    «¿Olvidaste tu contraseña?», DX-010);
  - cuenta **sin verificar** (pudo crearla alguien sin acceso al correo): con
    su contraseña actual se une y queda verificada; con otra, **la reclama**:
    contraseña nueva, `emailVerifiedAt`, `tokenVersion + 1` (mueren todas las
    sesiones y refresh anteriores), se invalidan sus enlaces de
    restablecimiento y se audita `PASSWORD_RESET` con
    `metadata.reason = INVITATION_ACCOUNT_CLAIM`.
- **Tope diario** de invitaciones NUEVAS por clínica:
  `INVITATION_TENANT_DAILY_LIMIT` (default 30/24 h) → 429 en español.
- El login sigue sin enumeración por tiempo (DX-049, hash ficticio).

## Recuperar la contraseña (DX-010)

- `POST /auth/forgot-password` `{ email }` → **siempre 202** con el mismo
  cuerpo, exista o no la cuenta y esté o no activa: la búsqueda, el token y el
  encolado del email corren en segundo plano, así que ni el cuerpo ni el tiempo
  de respuesta delatan nada. Solo se envía a un **miembro activo de la clínica
  del host**, con su marca y un enlace `<PUBLIC_WEB_PROTOCOL>://<host>/restablecer/<token>`.
  Si se superan los topes `MAIL_*` no se envía (y tampoco se dice).
- `POST /auth/reset-password/check` `{ token }` → `{ status: VALID | EXPIRED | USED | INVALID }`.
- `POST /auth/reset-password` `{ token, password }` → 204. Exige la política de
  contraseña (8–200), consume el token (un solo uso, check-and-set), invalida
  los demás e incrementa `tokenVersion` (cierra todas las sesiones, como el
  cambio de contraseña). Errores en español: 404 (inexistente, reemplazado o de
  otra clínica) y 410 (caducado o usado). Deja un evento `PASSWORD_RESET` en la
  auditoría, sin datos sensibles.
- Token: 32 bytes aleatorios (base64url); en `user_tokens` solo su SHA-256,
  caduca a los 30 min y pedir otro invalida los anteriores. Tabla global de
  usuario (sin `tenantId` ni RLS, como `users`): el enlace solo vale en el host
  de una clínica donde el usuario tiene membresía activa.
- Rate limit `password-reset` por IP, un balde por ruta
  (`RATE_LIMIT_PASSWORD_RESET_LIMIT`/`_TTL_MS`, 10 cada 15 min).
- En local, para abrir el enlace sin SMTP: `MAIL_TRANSPORT=file
  MAIL_FILE_DIR=./.mail` deja cada email como JSON en esa carpeta (prohibido en
  producción; lo usa el Playwright de la web).

## Odontograma: dentición, origen y anulación (DX-120)

- **Dentición por posición**: cada una de las 32 posiciones (código FDI
  permanente; el 55 ocupa la 15) está en `PERMANENT`, `PRIMARY` o `MIXED`.
  `GET /patients/:id/dentition` devuelve el último evento de cada posición o,
  sin eventos, la de su edad (< 6 años temporal, 6–12 según la tabla de
  erupción de `domain/dentition.ts`, > 12 permanente; sin fecha de
  nacimiento, permanente). No escribe nada. `POST
  /patients/:id/dentition-events` cambia una o varias posiciones
  (`MANUAL`/`ERUPTION`/`EXFOLIATION`); los molares no tienen mixta y exfoliar
  deja la posición en permanente (422, también CHECK en la BD).
- **Registro y dentición**: `POST tooth-records` rechaza con 422 un temporal
  en una posición en permanente y un permanente en una en temporal. `origin`:
  `THIS_CLINIC` (por defecto), `PRE_EXISTING` u `OTHER_PROVIDER`.
- **Anulación**: `POST tooth-records/:recordId/void` con `reason` inserta OTRO
  registro (`voidsRecordId`, `voidReason`); el original no cambia. Solo el
  autor o un ADMIN (403); sin motivo, 400; una segunda vez, 409 (índice único
  parcial `tooth_records_void_once_key`). La carta deja de pintarlo y
  `teeth/:fdi/history` lo devuelve con su `void` (motivo, autor y fecha).
- **Carta a una fecha**: `?asOf=YYYY-MM-DD` en `odontogram` y `dentition`
  corta al final de ese día en la zona de la sede: lo anulado después sigue,
  lo posterior no aparece. Futuro o inválido, 400.
- **Inalterable en la BD**: `tooth_records` y `patient_dentition_events`
  rechazan UPDATE siempre y DELETE/TRUNCATE salvo a un superusuario (trigger
  `dx_forbid_odontogram_mutation`, `search_path` fijo — SEC-032). RLS forzada
  y FK compuestas por tenant y paciente. Cada cambio de dentición (`UPDATE`,
  `DENTITION_CHANGED`) y cada anulación (`VOID`) dejan su `audit_event`.

## Días civiles y zona de la sede (DX-097)

La caja (`GET /payments`), el dashboard (`GET /dashboard`) y el estado de
cuenta (`GET /patients/:id/account-statement`) reciben días civiles
`YYYY-MM-DD` y los cortan a **medianoche de la zona IANA de cada sede**, no a
medianoche UTC: un abono de las 20:00 en Bogotá (01:00 UTC del día siguiente)
cuenta en su día.

- **Zona de la sede**: la de su horario (`location_schedules.timezone`); sin
  horario, la de su país (CO → `America/Bogota`, ES → `Europe/Madrid`). Siempre
  de la BD, nunca del cliente. `GET /locations` la publica (`timeZone`) para que
  la web sepa qué día es «hoy» en la sede. Una sede nueva nace con el horario en
  la zona de su país.
- **Varias sedes**: en la vista consolidada cada sede corta su día en su zona;
  la consulta lleva una rama `(locationId IN (...) AND paidAt en [a, b))` por
  ZONA (no por sede), servida por `payments_tenantId_locationId_paidAt_active_idx`.
- **Utilidad única**: `src/shared/time/civil-day.ts` (`civilRangeInZone`,
  `civilDayRange`, `civilDateIn`…), solo con `Intl`; el cambio de hora (días de
  23 y 25 h) está probado con `Europe/Madrid`.
- **Registro de abonos**: `paidAt` puede ser un instante ISO con hora o solo el
  día `YYYY-MM-DD`, que se guarda al mediodía de la sede. La migración
  `20261017113000_payments_civil_day_noon` movió los abonos antiguos guardados a
  medianoche UTC (los días del formulario) al mediodía de su sede, sin cambiar
  su día civil ni su día UTC.
- Las filas de caja y los movimientos del estado de cuenta traen `paidOn`: el
  día civil del pago en la zona de su sede (es lo que hay que mostrar).
- `GET /dashboard`: `to` sigue siendo EXCLUSIVO (`[from, to)`).

## Despliegue: roles de la BD (DX-113)

En un Postgres gestionado (RDS, Cloud SQL…) nadie de la aplicación es
superusuario ni tiene BYPASSRLS. Hay dos roles con login y dos NOLOGIN que
crean las migraciones; el job `owner-nosu` de la CI despliega así desde cero
en cada PR (migraciones, seed de referencia, `seed:demo`, comprobación de
FORCE y `npm run test:owner-nosu`).

| Rol | Conexión | Privilegios mínimos | Nunca |
|-----|----------|---------------------|-------|
| owner (p. ej. `dentalix_owner`) | `DIRECT_URL`: solo `prisma migrate deploy`, `prisma db seed` y `audit:purge` | `LOGIN`, `CREATEROLE` (crea `dentalix_app` y los roles NOLOGIN de abajo), dueño de la base (`CREATE` para las extensiones *trusted* `unaccent`, `btree_gist`, `pg_trgm`, `btree_gin`) y del esquema `public` (en PG15+ lo es por `pg_database_owner`; en PG ≤ 14, `ALTER SCHEMA public OWNER TO …`) | `SUPERUSER`, `BYPASSRLS`, `CREATEDB`, `REPLICATION`; ni lo usa la API |
| `dentalix_app` (nombre fijo: lo citan las migraciones) | `DATABASE_URL`: la API y `seed:demo` | `LOGIN`, `CONNECT`, `USAGE` en `public`, `SELECT/INSERT/UPDATE/DELETE` en tablas y `USAGE/SELECT` en secuencias (privilegios por defecto del owner) y `EXECUTE` en las funciones que le conceden las migraciones (búsqueda de pacientes, despachador de email, particiones de auditoría) | dueño de tablas, `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB` |
| `dentalix_patient_search` (DX-043) | NOLOGIN | dueño de `dx_patient_search_*`; `SELECT` de 5 columnas de `patients` y su política | `LOGIN`, `BYPASSRLS`, miembros con `SET`/`INHERIT` |
| `dentalix_email_dispatcher` (DX-113) | NOLOGIN | dueño de `email_outbox_claim/_settle/_enqueue_platform`; `SELECT/INSERT/UPDATE` de `email_outbox` y su política | `LOGIN`, `BYPASSRLS`, miembros con `SET`/`INHERIT` |

Pasos (el `psql` no acepta el `?schema=public` de las URL de Prisma:
`"${DIRECT_URL%%\?*}"` lo quita):

```bash
# 1. Como admin del proveedor: el owner y la base.
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE dentalix_owner LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB NOREPLICATION;
CREATE DATABASE dentalix OWNER dentalix_owner;
SQL
# 2. Como el owner: dentalix_app y sus privilegios por defecto (idempotente;
#    comprueba que la app no salte la RLS). `app_password` solo hace falta si
#    dentalix_app aún no existe en el clúster; si existe, no cambia su contraseña.
psql "${DIRECT_URL%%\?*}" -v ON_ERROR_STOP=1 -v app_password="$(openssl rand -hex 24)" \
  -f docker/prod/create-app-role.sql
# 3. Como el owner, en un job previo al despliegue (no en el arranque de cada réplica):
npx prisma migrate deploy && npx prisma db seed
# 4. Comprobación tras el despliegue (DX-134): ninguna tabla de public con RLS
#    sin FORCE. Sale con 0 si todo está bien, 1 (y la lista) si no, 2 si no pudo
#    comprobarlo. Si no sale con 0, NO des el despliegue por bueno.
npm run db:check-force
```

**Si `db:check-force` falla** (sale con 1 y lista tablas): una migración que
quita FORCE y lo devuelve (`…_dx113_reforce_*`, o una con `NO FORCE`/`FORCE`
en su transacción) se quedó a medias, típicamente por el `lock_timeout` de 5 s
con tráfico. Mientras tanto la app sigue aislada (`dentalix_app` no es dueña
de las tablas), pero el owner, y con él `migrate`, `db seed` y `audit:purge`,
ya no está sujeto a la RLS de esas tablas. Recuperación:

```bash
npx prisma migrate status                      # nombra la migración fallida
npx prisma migrate resolve --rolled-back <migración>
npx prisma migrate deploy                      # la repite (y su reforce)
npm run db:check-force                         # ahora tiene que salir con 0
```

Si `migrate status` no muestra ninguna fallida, alguien quitó FORCE a mano:
devuélvelo como el owner con `ALTER TABLE "<tabla>" FORCE ROW LEVEL SECURITY`
y repite la comprobación. La CI la ejecuta en los jobs de integración y
`owner-nosu`, y `test/rls-catalog.int-spec.ts` la cubre también.

- **FORCE y el owner**: todas las tablas con `tenantId` tienen RLS ENABLE +
  FORCE, así que el owner también está sujeto a la RLS y, sin
  `app.current_tenant`, no ve filas de clínica. Lo comprueba
  `test/rls-catalog.int-spec.ts` (también en el job `owner-nosu`, leyendo
  `pg_class.relforcerowsecurity` con el owner real). El owner puede quitar
  FORCE (es el dueño): no es una frontera de seguridad, pero así nada en
  producción necesita superusuario ni BYPASSRLS.
- **Migraciones con datos** (regla para las nuevas): si una migración lee o
  escribe filas de tablas con FORCE, quita FORCE a esas tablas **en la misma
  transacción** y lo restaura al final (`ALTER TABLE … NO FORCE ROW LEVEL
  SECURITY` / `FORCE …`). `SET LOCAL row_security = off` solo no basta: con
  este owner hace fallar la migración; y sin él, un UPDATE o un INSERT …
  SELECT actúa sobre 0 filas en silencio. Añade un tramo con filas previas a
  `test/owner-nosu/migrations-data.owner-spec.ts`.
- **Añadir o validar una FOREIGN KEY también cuenta como leer filas** (DX-134):
  `ALTER TABLE … ADD … FOREIGN KEY` (sin `NOT VALID`) o `VALIDATE CONSTRAINT`
  sobre una tabla que ya tenía FORCE necesita `NO FORCE` en la misma
  transacción (y `FORCE` al final). Con FORCE, la validación recorre la tabla
  hija con la RLS del owner: no ve ninguna fila de clínica y **acepta la FK
  aunque haya filas huérfanas**, en silencio (los `CHECK` y los índices únicos
  sí las ven). Con `NO FORCE` la misma migración falla de forma ruidosa si hay
  huérfanas. Lo demuestra `test/owner-nosu/fk-under-force.owner-spec.ts`, y el
  lint `test/migrations/fk-under-force.spec.ts` (en `npm test`) falla si una
  migración nueva lo incumple. No cuenta una tabla creada en la misma migración
  (está vacía). Las migraciones antiguas que ya lo hacían están en su allowlist,
  comentadas, y no se editan.
- **Migraciones antiguas**: las de datos van entre una pareja
  `…_dx113_unforce_<x>` / `…_dx113_reforce_<x>` que quita y devuelve FORCE
  solo a las tablas que tocan. En una base ya migrada las parejas se aplican
  seguidas y no cambian nada (Prisma aplica migraciones intercaladas sin pedir
  reset). Tres migraciones solo podían arreglarse por dentro (mismo `NO
  FORCE`/`FORCE` en su transacción; el esquema resultante es idéntico):
  `20261016170000_data_processing_consents`,
  `20261017113000_payments_civil_day_noon` y `20261017120000_email_outbox`.
  DX-134 editó además la comprobación de miembros de los roles del clúster en
  `20261017114000_patient_search_and_list_indexes` y
  `20261017175000_dx113_email_outbox_dispatcher_role` (ver «Roles del clúster
  y varias bases»; solo cambia el bloque `DO` de comprobación, nada del
  esquema).
  `migrate deploy` no mira el checksum, pero en una base de desarrollo ya
  migrada `prisma migrate dev` dirá *«was modified after it was applied»* y
  propondrá un reset. **No lo aceptes**: actualiza el checksum (no toca datos)
  y sigue con `migrate deploy`:

  ```bash
  for m in 20261016170000_data_processing_consents 20261017113000_payments_civil_day_noon 20261017120000_email_outbox \
           20261017114000_patient_search_and_list_indexes 20261017175000_dx113_email_outbox_dispatcher_role; do
    sum=$(sha256sum prisma/migrations/$m/migration.sql | cut -d' ' -f1)
    psql "${DIRECT_URL%%\?*}" -v ON_ERROR_STOP=1 \
      -c "UPDATE _prisma_migrations SET checksum = '$sum' WHERE migration_name = '$m'"
  done
  npx prisma migrate deploy
  ```
- **Una base con datos migrada en su día con superusuario** que tuviera que
  repetir `20260801150000_add_locations` con este owner: falla de forma ruidosa
  (inserta la sede por defecto en una tabla nueva con FORCE) y no toca nada.
  Repítela una vez con `BYPASSRLS` temporal (`prisma migrate resolve
  --rolled-back …` y `ALTER ROLE … BYPASSRLS` / `NOBYPASSRLS`). Un despliegue
  nuevo la aplica vacía y no lo necesita.
- **Roles del clúster y varias bases** (DX-134): `dentalix_app`,
  `dentalix_patient_search` y `dentalix_email_dispatcher` son del clúster, no
  de la base. Todas las bases de un mismo clúster los comparten (también la
  contraseña de `dentalix_app`), así que forman **un único dominio de
  confianza**: para aislar entornos (producción frente a staging) usa
  clústeres distintos. Dentro de un clúster puede haber bases de owners
  distintos:
  - El owner sin superusuario que crea un rol NOLOGIN queda como miembro suyo
    solo con ADMIN (PG16: sin SET ni INHERIT). Las migraciones toleran como
    miembros al migrador y a **los owners de otras bases del clúster sin SET
    ni INHERIT**; cualquier otro miembro (p. ej. uno con SET, que podría
    reemplazar las funciones o leer sin RLS) aborta la migración con
    *«tiene miembros inesperados: <roles>»*.
  - Un owner que no creó los roles (un segundo owner, o los creó un
    superusuario como el `dentalix` del docker local) necesita ADMIN OPTION.
    Sin ella la migración aborta con *«<owner> no tiene ADMIN OPTION sobre el
    rol …»* y el GRANT exacto, que el admin del clúster ejecuta antes:

    ```sql
    GRANT dentalix_patient_search, dentalix_email_dispatcher TO <owner>
      WITH ADMIN OPTION, INHERIT FALSE, SET FALSE;
    ```

    Si ya falló, tras el GRANT: `npx prisma migrate resolve --rolled-back
    <migración>` y `npx prisma migrate deploy`.
  - `create-app-role.sql` en la segunda base no necesita `app_password`
    (`dentalix_app` ya existe y conserva su contraseña).
  - Al retirar una base, retira también a su owner de esos roles (`DROP ROLE`
    o `REVOKE … FROM <owner>`): un miembro que ya no es owner de ninguna base
    deja de tolerarse.

  Lo prueba `test/owner-nosu/shared-cluster.owner-spec.ts`.
- **En local**, con un Postgres aparte (los roles son del clúster; p. ej.
  `docker run -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:16`): crea
  el owner y la base como en el paso 1, aplica los pasos 2 a 4, y
  `DIRECT_URL=<owner> DATABASE_URL=<app> OWNER_NOSU_ADMIN_URL=<admin>/postgres
  npm run test:owner-nosu`. Los specs crean y borran sus propias bases y, el
  de clúster compartido, un segundo owner `<owner>_b134`.

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
