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
   el sábado de la próxima en distintos estados (las de valoración, limpieza, endodoncia, urgencia y ortodoncia con su tipo), bloqueos de agenda (vacaciones de la segunda dentista de lunes a viernes de la semana siguiente a la próxima, en todas las sedes, y el almuerzo del equipo en la sede principal el próximo día laborable, que deja agendar con aviso) y 3 «Pendientes por agendar» abiertos (las dos cancelaciones o no-shows más recientes y un alta manual urgente; las más antiguas quedan descartadas con motivo) — DX-122, planes de tratamiento en todos
   sus estados (con un presupuesto en borrador con descuentos, listo para
   presentar, y otro aceptado con la firma del paciente — DX-012; y dos opciones A/B de Carolina Duque —implante o puente— presentadas hace 9 días y sin cita futura, que salen en «Presupuestos por seguir» — DX-040), abonos en COP de los últimos 60 días en ambas sedes, cada uno con su recibo de caja numerado por sede (`PRI-000001`…, `NOR-000001`…; el abono duplicado anulado conserva su número y sale «ANULADO» — DX-136), un plan de
   pagos con cuotas e inventario por sede con ítems bajo el stock mínimo. Varios planes se abrieron hace 20, 40, 75 y 100 días (`openedDaysAgo`), así que la cartera (DX-145) tiene deudores en todos los tramos en las dos sedes.

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
- **Despachador en proceso** (`EmailDispatcher`; sigue en cada réplica tras la cola de DX-085, ver «Trabajos en segundo plano»): se
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
  `20261017120000_email_outbox` (y las del tope y la purga de plataforma de
  `20261017231200_dx144_platform_email_quota`, DX-144), concedidas
  explícitamente a `dentalix_app`.
  Desde DX-113 son del rol NOLOGIN `dentalix_email_dispatcher` (sin
  BYPASSRLS, con una política permisiva en `email_outbox` solo para él), no
  del owner de las migraciones, que en un Postgres gestionado no se salta la
  RLS (ver «Despliegue: roles de la BD»). El arriendo de un reclamo se acota a 900 s y el cierre de
  un intento solo vale para ESE intento (fencing por `attempts`). Si el rol de la app se crea después de migrar, concédele
  `EXECUTE` sobre `email_outbox_claim`, `email_outbox_settle`,
  `email_outbox_enqueue_platform_capped`, `email_outbox_platform_allowed` y
  `email_outbox_purge_platform` (`create-app-role.sql` avisa de las que
  falten). `email_outbox_enqueue_platform`, sin tope, solo queda para las
  réplicas de la versión anterior durante el despliegue de DX-144.
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
- **Tope de los emails de plataforma** (DX-144, SEC-034; sin clínica: la
  verificación y el aviso del registro público): como mucho **1 cada 10 min
  y 3 en 24 h al mismo destinatario**, contados en la BD por el **hash** del
  destinatario (`toHash`, nunca el email) y atómicos entre réplicas (un
  candado por hash en `email_outbox_enqueue_platform_capped`). Al pasarlo el
  email no sale y nadie se entera: el registro sigue respondiendo el mismo
  202. Variables (ver `.env.example`):

  | Variable | Default | Rango |
  |----------|---------|-------|
  | `MAIL_PLATFORM_RECIPIENT_COOLDOWN_SECONDS` | `600` | 0..86400 (0 = sin enfriamiento) |
  | `MAIL_PLATFORM_RECIPIENT_DAILY_LIMIT` | `3` | 1..1000 |

  `EmailOutbox.enqueue` exige clínica; los de plataforma solo pueden salir
  por `EmailOutbox.enqueuePlatform`, que aplica el tope. Los e2e lo apagan en
  `test/setup-e2e.ts` (se registran sin parar con los mismos correos).

**Invitaciones**: `POST /staff/invitations` encola el email `invitation` con
el enlace `<protocolo>://<host de la clínica>/invitacion/<token>` (el host con
el que llegó la petición si es de plataforma; si llegó por un dominio
personalizado, `<subdominio>.<primer TENANT_BASE_DOMAINS>`, ver SEC-033 más
abajo; el protocolo sale de `PUBLIC_WEB_PROTOCOL`). Desde DX-029 **el token ya no se devuelve al ADMIN**:
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
  registrar una clínica con tu correo…»).
  **Sin relé de emails** (DX-144, SEC-034): `clinicName` y `fullName` ≤ 120
  caracteres (400 en español); el email de verificación saluda con un
  «Hola:» genérico y no lleva nada escrito por el solicitante; cada
  destinatario recibe como mucho los emails del tope de plataforma (ver
  «Email transaccional»), comprobado en segundo plano, así que ni el cuerpo
  ni el tiempo de la respuesta cambian al alcanzarlo; y un alta repetida con
  el mismo email dentro del enfriamiento (10 min) **no reemplaza** el
  pendiente vigente: el enlace de quien se está registrando sigue valiendo.
  Pasado el enfriamiento (o caducado el pendiente), sí lo reemplaza. 409 solo si el **subdominio** está
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
  ya no trae `userExists` sino `requiresCurrentPassword` (true para una
  cuenta **verificada** o una sin verificar que no se puede reclamar, ver
  abajo), que solo ve quien recibió el correo. Aceptar:
  - sin cuenta → se crea con `emailVerifiedAt`;
  - cuenta verificada → exige su contraseña (401 en español; si la olvidó,
    «¿Olvidaste tu contraseña?», DX-010);
  - cuenta **sin verificar** (pudo crearla alguien sin acceso al correo): con
    su contraseña actual se une y queda verificada; con otra, **la reclama**:
    contraseña nueva, `emailVerifiedAt`, `tokenVersion + 1` (mueren todas las
    sesiones y refresh anteriores), se invalidan sus enlaces de
    restablecimiento y se audita `PASSWORD_RESET` con
    `metadata.reason = INVITATION_ACCOUNT_CLAIM`.
  - **DX-143 (SEC-033):** nunca se reclama una cuenta que ya da acceso a
    **otra clínica** (alguna membresía activa, es decir, sin `deletedAt`, en
    un tenant distinto del de la invitación) ni la de un **administrador de
    plataforma**: con otra contraseña, 401 en español que remite a «¿Olvidaste
    tu contraseña?» en la clínica donde ya trabaja, sin tocar `passwordHash`,
    `tokenVersion` ni `emailVerifiedAt` (y sin consumir la invitación: con su
    contraseña actual se une como siempre). Se comprueba en el caso de uso y
    otra vez dentro de la transacción, con la fila del usuario bloqueada
    (`FOR UPDATE`). Las membresías de otras clínicas no se ven bajo la RLS:
    lo responde `dx_user_has_other_active_memberships(user, tenant)`, SECURITY
    DEFINER del rol NOLOGIN `dentalix_membership_lookup` (solo un booleano;
    ver «Despliegue: roles de la BD»).
- **Cuentas anteriores a DX-029 ya verificadas** (migración
  `20261017231100_dx143_verify_active_accounts`, idempotente, solo filas con
  `emailVerifiedAt` NULL y no borradas). Criterio:
  1. la cuenta **inició sesión con éxito** alguna vez: un evento `LOGIN` de
     `audit_events` con ella como actor, en cualquier clínica (un
     `LOGIN_FAILED` no cuenta). Fecha: la del primer `LOGIN`;
  2. o es la **dueña creada por el registro**: `ADMIN` de una clínica con la
     que nació a la vez (usuario, clínica y membresía a menos de 60 s; el
     registro los creaba en una transacción). Fecha: el alta del usuario.

  Además, la cuenta tiene que tener **hoy al menos una membresía activa** en
  una clínica no borrada. Una cuenta sin acceso a ninguna clínica no gana nada
  con quedar verificada y, si lo quedara, quien controla el buzón ya no
  podría reclamarla con una invitación ni restablecerla (DX-010 exige
  membresía): es el caso de una cuenta pre-secuestrada (SEC-007) cuya clínica
  ya no existe. Ojo: los dos criterios también verifican una cuenta
  pre-secuestrada con su clínica activa (el atacante inició sesión o registró
  la clínica). No empeora nada: esa cuenta ya no se puede reclamar porque da
  acceso a otra clínica, y quien controla el buzón la recupera con
  «¿Olvidaste tu contraseña?» en esa clínica (el enlace llega a su buzón).

  Si cumple las dos, la fecha más antigua. Quien inició sesión ya demostró
  conocer la contraseña, y la dueña controla su clínica; las dos quedan fuera
  del reclamo de ahora en adelante. Los eventos `LOGIN` existen desde DX-009
  (antes, solo cuenta el criterio 2). Una cuenta verificada que olvida su
  contraseña la restablece desde una clínica donde sea miembro (DX-010).
  Con un owner sin superusuario funciona porque quita FORCE a `audit_events`
  y `clinic_memberships` solo durante su transacción
  (`test/owner-nosu/migrations-data.owner-spec.ts`).
  **En producción:** `ALTER TABLE … NO FORCE` toma un `ACCESS EXCLUSIVE` sobre
  `audit_events` (el padre) y `clinic_memberships` hasta el final de la
  transacción, que recorre todos los eventos `LOGIN` (no hay índice por
  `action`). Mientras dura esperan el inicio de sesión y todo lo que lee
  membresías o escribe auditoría: despliégala en una ventana de poco
  tráfico. `lock_timeout = 5s`
  solo limita la espera por el bloqueo, no lo que dura el `UPDATE`.
- **Tope diario** de invitaciones NUEVAS por clínica:
  `INVITATION_TENANT_DAILY_LIMIT` (default 30/24 h) → 429 en español.
- El login sigue sin enumeración por tiempo (DX-049, hash ficticio).

## Recuperar la contraseña (DX-010)

- `POST /auth/forgot-password` `{ email }` → **siempre 202** con el mismo
  cuerpo, exista o no la cuenta y esté o no activa: la búsqueda, el token y el
  encolado del email corren en segundo plano, así que ni el cuerpo ni el tiempo
  de respuesta delatan nada. Solo se envía a un **miembro activo de la clínica
  del host**, con su marca y un enlace `<PUBLIC_WEB_PROTOCOL>://<host>/restablecer/<token>`.
  **SEC-033:** los enlaces con un token de la cuenta global (este y el de la
  invitación) nunca apuntan a un dominio personalizado (su DNS lo controla la
  clínica): `<host>` es el de la petición solo si es de plataforma
  (`TENANT_BASE_DOMAINS`); si no, `<subdominio de la clínica>.<primer dominio
  base>` (`TenantLinkBaseService` / `tenantLinkHost`). El enlace de
  confirmación de cita (DX-005) sí puede usar el dominio de la clínica: solo
  confirma esa cita. Además (DX-143), aceptar una invitación no reclama una
  cuenta sin verificar con acceso a otra clínica (ver DX-029 arriba).
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

## Bloqueo del login por intentos fallidos (DX-048)

Sustituye a los baldes `login` (IP+email, 5/15 min) y `login-account` (email,
50/h) del rate limiter, que contaban también los logins correctos y dejaban a
una clínica tras NAT, o a una doctora atacada desde varias IPs, sin entrar
hasta 1 h (SEC-028).

- **Por cuenta** (hash SHA-256 del email normalizado; nunca el email en claro):
  solo cuentan los **fallos** (401) y un login correcto borra el contador. Sin
  espera hasta 5 fallos; después 1, 2, 4, 8 min con **tope de 15 min**. Los
  fallos se olvidan tras 1 h sin fallar. Durante la espera se responde 429
  **sin mirar la contraseña** (ni un acierto pasa ni se paga argon2).
- **El intento se cobra antes de verificar**: cada intento fuera de espera suma
  un fallo a la cuenta en UNA sentencia atómica (`INSERT … ON CONFLICT DO
  UPDATE … WHERE` no en espera) y el login correcto lo borra después. Si se
  contara al recibir el 401, N peticiones simultáneas en cuanto acaba una
  espera probarían N contraseñas; así solo pasa una por espera. Un error que
  no es 401 (p. ej. un 500) deja ese intento contado.
- **Por IP** (hash): solo fallos, 100 por ventana fija de 15 min; al llegar, la
  IP espera a que acabe la ventana. Un acierto no la reinicia (un atacante la
  limpiaría entrando con su propia cuenta). La IP es `req.ip`: depende de
  `TRUST_PROXY` (ver SEC-031).
- **429**: cabecera `Retry-After` (segundos) y `message` «Demasiados intentos.
  Vuelve a intentarlo en N min.», idénticos exista o no el email (el contador
  existe para cualquier email escrito) y por el mismo camino, sin tiempo
  distinto. El 401 sigue siendo el genérico de SEC-017.
- **Entre réplicas**: los contadores viven en `login_throttles` (tabla de
  plataforma sin `tenantId` ni RLS, como `revoked_tokens`: solo hashes,
  `CHECK` de SHA-256 en hex), con escrituras atómicas `INSERT … ON CONFLICT` y
  la hora de la BD. La purga va en el trabajo horario
  `auth.purge-expired-tokens` (filas sin fallos en más de 1 h y sin espera).
- **Rate limiter**: el login conserva solo `login-burst` (60/min por IP, en
  memoria de cada réplica) contra avalanchas; holgado para una clínica entera.
- **Desbloqueo por un ADMIN**: `GET /staff/:userId` trae `loginBlockedUntil`
  (`null` = sin bloqueo) y `POST /staff/:userId/login-unlock` (204, solo
  ADMIN; 404 si no es miembro de su clínica, 403 otros roles) borra la espera
  y los fallos. Deja un evento `UPDATE` / `STAFF_MEMBER` con
  `reason: LOGIN_UNLOCKED` en la auditoría.
- **Cuenta global, varias clínicas**: el contador es de la cuenta (el email),
  no de la membresía, así que un ADMIN de **cualquiera** de las clínicas del
  usuario le desbloquea en todas. Se acepta: solo borra una espera de como
  mucho 15 min que se iría sola, no da acceso a nada (sigue haciendo falta la
  contraseña), exige ser ADMIN de una clínica de la que el usuario es miembro
  (bajo RLS: de otra clínica, 404) y queda auditado en la clínica del ADMIN.
  El perfil de un miembro también revela al ADMIN que alguien falló con ese
  email (en cualquier clínica), lo que es justo lo que necesita para decidir.
- **Riesgo residual**: un atacante que manda un intento malo cada vez que
  acaba la espera mantiene la cuenta en esperas de 15 min (no la deja fuera
  1 h, pero la doctora solo entra si llega antes que él). El ADMIN puede
  desbloquear; si ocurre, la mitigación siguiente sería no aplicar la espera
  de la cuenta a IPs/dispositivos donde ya entró (fuera de DX-048).
- Variables (defaults seguros; valor inválido = no arranca):
  `LOGIN_LOCKOUT_FREE_FAILURES` (5), `LOGIN_LOCKOUT_BASE_DELAY_MS` (60000),
  `LOGIN_LOCKOUT_MAX_DELAY_MS` (900000), `LOGIN_LOCKOUT_RESET_MS` (3600000,
  debe ser mayor que el tope), `LOGIN_IP_FAILURE_LIMIT` (100),
  `LOGIN_IP_FAILURE_WINDOW_MS` (900000), `RATE_LIMIT_LOGIN_BURST_LIMIT` (60) y
  `RATE_LIMIT_LOGIN_BURST_TTL_MS` (60000). `RATE_LIMIT_LOGIN_*` y
  `RATE_LIMIT_LOGIN_ACCOUNT_*` ya no se leen: quítalas del despliegue.
- En local, para salir de una espera sin esperar: `DELETE FROM login_throttles;`
  (o el botón «Desbloquear inicio de sesión» del perfil del miembro).

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

## Cartera por antigüedad (DX-145, DX-155)

`GET /api/v1/receivables/aging` (ADMIN y RECEPTION; 403 en español al resto):
los deudores de la sede, de la deuda vencida más antigua a la más reciente,
paginados (`page`, `pageSize` ≤ 100) y con una fila de totales por tramo y
moneda de TODAS las filas filtradas. Filtros: `locationId` (si no, la sede de
`X-Location-Id`; sin ninguna, toda la clínica), `currency`, `minBalance` y
`minAgeDays` (91 = «más de 90 días»). `GET /api/v1/receivables/aging.csv`:
mismos filtros sin paginar, **solo ADMIN**, y cada descarga deja un evento
`EXPORT` en la auditoría (recurso `ACCOUNT_STATEMENT`, `reason`
`RECEIVABLES_AGING`; la lista deja un `VIEW` igual). Módulo
`src/modules/receivables`.

- **Un solo cálculo de saldo**: el de cada paciente es el del estado de cuenta
  (`computeBalances`, el núcleo de `computeAccountStatement`); la cartera solo lo
  reparte en líneas fechadas. El e2e comprueba que cada fila = su estado de
  cuenta.
- **Antigüedad** por línea de deuda, en días civiles de la zona de la sede
  (DX-097): una cuota de un plan de pagos, desde su vencimiento (si aún no
  vence, tramo «por vencer», `current`); lo que no está en cuotas, desde la
  aceptación firmada del plan, o su presentación, o su creación, **siempre con
  `ageApproximate: true`** (aún no hay fecha de realización por ítem, DX-050).
  Si el calendario suma más que el saldo del plan, solo envejece el saldo,
  desde la cuota más antigua.
- **Tramos** 0–30, 31–60, 61–90 y > 90 días (y «por vencer») por moneda, sin
  convertir. El **saldo a favor** (abonos de más, de un plan cancelado o en otra
  moneda) va aparte y nunca se resta de los tramos: `balance = debt − credit`.
  Un paciente con solo saldo a favor no es deudor y no sale.
- **Sede de la deuda**: la de la última cita ATENDIDA (COMPLETED) del paciente;
  sin citas atendidas, la de su último abono; sin abonos, la de la última
  presentación de un plan; sin nada de eso, ninguna (`locationId: null`), y
  entonces solo sale en la vista de toda la clínica.
- **Resumen por paciente `patient_ledgers` (DX-155)**: la lista lee, en UNA
  consulta, las ENTRADAS de cada deudor ya reunidas por la BD: las sumas de
  cada plan vivo (facturable y abonado, en su moneda y en otras), sus planes de
  cuotas con las cuotas, la sede de la deuda y si debe (`owing`, índice parcial
  `patient_ledgers_owing_idx`). No guarda saldos: el saldo y los tramos siguen
  saliendo de `computeBalances` con el «hoy» de cada petición.
  - **Lo mantiene la BD**: triggers por sentencia en `patients`,
    `treatment_plans`, `treatment_plan_items`, `treatment_plan_acceptances`,
    `payments`, `payment_plans`, `installments` y `appointments` recalculan la
    fila de los pacientes que toca cada escritura (`patient_ledgers_refresh`,
    con `patient_ledgers_compute`: una sola definición, también para el
    backfill). Ningún caso de uso tiene que acordarse de nada, y una escritura
    nueva en esas tablas (p. ej. otro tipo de abono) queda cubierta sola.
  - **Concurrencia**: el refresco bloquea en orden la fila de esos pacientes
    en `patients` (FOR NO KEY UPDATE, que existe aunque aún no tengan fila en
    el resumen) y la del resumen, y recalcula después con una foto nueva (READ
    COMMITTED): dos abonos simultáneos del mismo paciente cuentan los dos, y una
    cita atendida o un archivado simultáneos al alta del primer plan también.
  - **Solo la BD lo escribe**: un trigger de guarda rechaza INSERT, UPDATE y
    DELETE directos con contexto de tenant. Para reparar una fila, como el
    owner con `app.current_tenant` fijado: `SELECT
    patient_ledgers_refresh(ARRAY['<tenant>']::uuid[], ARRAY['<paciente>']::uuid[])`.
  - **RLS FORCE** por tenant y FK compuesta al paciente; los triggers corren
    con el rol de la app. Un refresco que no ve a un paciente afectado falla
    («no se ven N de M pacientes…») en vez de dejar su fila vieja: una
    migración de datos que escriba en esas tablas sin contexto de tenant debe
    quitar FORCE también a `patient_ledgers` y a las tablas que lee el refresco
    (ver «Despliegue: roles de la BD»).
- **Rendimiento**: con 60k pacientes (13k deudores en la sede, 23k en la
  clínica) la lista de una sede tarda ~0,25–0,3 s y la de toda la clínica
  ~0,6 s en una máquina compartida; antes de DX-155, ~0,65 s y ~1,2 s
  (`docs/perf/DX-145.md`). Lo que queda es el cálculo en memoria con el núcleo
  del estado de cuenta, que crece con los deudores.
- **Sin datos clínicos**: ni ítems, ni dientes, ni procedimientos; solo
  importes, fechas y el contacto (con `whatsApp` en E.164 para `wa.me`).

## Recibo de caja por abono (DX-136)

Cada abono nuevo nace con su **recibo de caja numerado por sede** (`NOR-000123`),
en la MISMA transacción que el abono (`issuePaymentReceipt`):

- **Serie de la sede**: `locations."receiptPrefix"` (2–6 caracteres, única por
  clínica, también entre sedes retiradas). Si no viene al crear la sede, el
  trigger `locations_default_receipt_prefix` la deriva del nombre: 3 letras sin
  tildes ni palabras genéricas ("Sede Norte" → `NOR`, "Sede principal" → `PRI`)
  y, si ya la usa otra sede de la clínica, con un número detrás (`NOR2`). La
  migración la rellenó en las sedes existentes. DX-019 dará la pantalla para
  cambiarla.
- **Contador**: `payment_receipt_counters` (una fila por serie) se incrementa
  con un UPSERT en la transacción del abono: el bloqueo de la fila ordena los
  cobros simultáneos (sin duplicados) y un rollback deshace el incremento (sin
  huecos). Un trigger solo lo deja avanzar de uno en uno y nunca borrarlo.
- **Recibo**: `payment_receipts` (uno por abono) guarda serie, número, quién y
  cuándo lo emitió y una **foto inmutable** (`snapshot` jsonb): clínica y sede
  (con sus datos fiscales; hoy solo existe el nombre y el recibo dice «Datos
  fiscales pendientes»), paciente con el documento **enmascarado**, importe,
  moneda, método, plan, saldo del plan tras el abono y quién cobró, y el pie
  «Este documento no es factura». Append-only por trigger: el número tiene que
  ser el del contador y la serie la de la sede; solo se puede marcar ANULADO
  una vez (al anular el abono, con su fecha, autor y motivo); nunca DELETE ni
  TRUNCATE salvo un superusuario (limpieza de las bases de test). RLS FORCE y
  FK compuesta por clínica a la sede; el abono va por su clave primaria y el
  trigger exige que sea de la misma clínica y sede (sin índice nuevo sobre
  `payments`).
- **Abonos anteriores** a la migración: no se renumeran. Salen con su
  referencia antigua `REC-xxxxxxxx` y marcados «sin serie» (`legacy: true`),
  con los datos de hoy.
- **Endpoints** (`PAYMENT_ROLES`: ADMIN y RECEPTION; el resto, 403 en
  español): `GET /payments/:id/receipt` (ver), `POST /payments/:id/receipt/print`
  (reimprimir: devuelve lo mismo y deja `PRINT` en la auditoría) y
  `POST /payments/:id/receipt/email` (202; encola en el outbox de DX-088 el
  mismo recibo al email de la ficha del paciente, con el documento
  enmascarado; 422 si no tiene email, 429 con los topes de la clínica). `GET
  /treatment-plans/:id/payments` devuelve `receiptNumber` en cada abono.
- **Auditoría**: la emisión va en el `CREATE PAYMENT` (`metadata.reason =
  RECEIPT_ISSUED`); ver, reimprimir y enviar son `VIEW`, `PRINT` y `SEND` sobre
  `PAYMENT_RECEIPT`.
- **Saldo en la foto**: se calcula antes de la transacción (la tasa de cambio
  puede pedir un proveedor externo) como el saldo previo más este abono
  convertido con la tasa de su día. Si no se puede calcular, el recibo sale
  sin saldo y el cobro no se bloquea. Con dos abonos simultáneos al MISMO plan,
  la foto de cada uno no incluye el otro.

## Trabajos en segundo plano (DX-085)

Cola y tareas programadas sobre la Postgres que ya existe (módulo
`src/modules/jobs`), sin Redis ni pg-boss: una tabla propia `jobs` reclamada
con `FOR UPDATE SKIP LOCKED`, para poder encolar **dentro de la transacción de
negocio** de Prisma y con el mismo rol `dentalix_app` (nada de superusuario ni
de esquemas propios de una librería).

- **Arrancar el worker** (misma imagen y mismo `dist/main.js`; `APP_ROLE`
  decide el papel):

  | `APP_ROLE` | Qué hace | Cómo |
  |------------|----------|------|
  | `api` (default) | Servidor HTTP; encola pero no ejecuta | `npm run start:prod` |
  | `worker` | Sin HTTP: ejecuta la cola y las tareas programadas | `npm run build && npm run start:worker` |
  | `all` | Las dos cosas en un proceso (desarrollo, despliegues pequeños) | `npm run start:dev:all` |

  En producción: N réplicas `api` + 1 o más `worker` (pueden ser varias: cada
  trabajo y cada tick los ejecuta uno solo). Con `SIGTERM` el worker deja de
  reclamar y espera a los trabajos en curso (`JOBS_SHUTDOWN_GRACE_MS`, 20 s,
  siempre menor que el arriendo); lo que no termine vuelve a la cola al
  momento (su handler recibe `signal` abortada). El periodo de gracia del
  orquestador (`terminationGracePeriodSeconds` en Kubernetes, 30 s por
  defecto) tiene que ser mayor que `JOBS_SHUTDOWN_GRACE_MS` más unos segundos
  de cierre. Sin worker
  nada se ejecuta (los trabajos esperan en `jobs`). Ajustes `JOBS_*`: ver
  `.env.example`.
- **Encolar** (outbox): `JobQueue.enqueue(name, payload, { tx, runAt,
  idempotencyKey, tenantId })`. Con `tx` (la de `runWithTenant`) el trabajo
  solo existe si el negocio hace commit. Su clínica es la del contexto de la
  petición o la de la transacción; un `tenantId` explícito que no coincida es
  un error. **Dentro de una petición de clínica `tx` es obligatoria** (o
  `outsideTransaction: true` a propósito). `idempotencyKey` única **por
  clínica** (o de plataforma): un segundo enqueue con la misma clave en la
  misma clínica no crea otro (mientras la fila exista; los terminados se
  purgan a los `JOBS_RETENTION_DAYS`, 14). Exige READ COMMITTED (el default). **Payload solo con ids** (CHECK de 4 KB), nunca
  datos del paciente.
- **Handlers** por módulo: en `onModuleInit`, `JobRegistry.register({ name:
  'modulo.trabajo', handle, maxAttempts?, retryBaseMs? })`. Si el trabajo
  tiene clínica, el handler corre con ese tenant en el contexto
  (`runWithTenant(fn)` lo usa). Mientras el handler trabaja, un latido
  renueva el arriendo cada tercio de `JOBS_LEASE_SECONDS` (con fencing por
  intento); si otro worker retomó el intento, `ctx.signal` se aborta y su
  resultado no cuenta. Entrega «al menos una vez»: handlers idempotentes. En
  los tests (`NODE_ENV=test`) el worker nunca arranca solo, aunque `.env`
  traiga `APP_ROLE`.
- **Reintentos**: backoff exponencial `base · 2^(intento-1)` (tope 1 h); al
  agotar `maxAttempts` queda `FAILED` y aparece en `GET
  /api/v1/platform/jobs/failed` (solo superadmin con token de plataforma;
  `limit` 1..100). `lastError` guarda tipo y código, nunca el mensaje.
- **Tareas programadas**: `JobRegistry.schedule({ name, cron, job })` (cron de
  5 campos en UTC). Cada tarea tiene su fila en `job_schedules`; el worker que
  la bloquea (SKIP LOCKED) encola el trabajo del tick con
  `idempotencyKey = schedule:<nombre>:<tick>` y la mueve al siguiente: una
  ejecución por tick con N workers. Un worker caído varios ticks no los
  recupera todos: corre una vez y sigue. Durante un despliegue que cambia un
  cron, solo dispara la tarea la réplica cuyo cron coincide con el de la
  fila. Las iniciales:

  | Tarea | Cron (UTC) | Qué hace |
  |-------|------------|----------|
  | `auth.purge-expired-tokens.hourly` | `17 * * * *` | Borra `revoked_tokens` y `pending_registrations` vencidos y `user_tokens` caducados/usados hace > 7 días. Sustituye a la limpieza lazy de cada logout/refresh |
  | `email.purge-outbox.daily` | `23 4 * * *` | Borra de `email_outbox` los SENT/FAILED de más de `MAIL_OUTBOX_RETENTION_DAYS` (90), clínica a clínica bajo su RLS, y los de plataforma por `email_outbox_purge_platform` (DX-144) |
  | `exchange.prefetch-rates.daily` | `5 0 * * *` | Precarga los tipos de cambio del día UTC (si hay `EXCHANGE_APP_ID`); la petición conserva el `fetch` como respaldo |
  | `jobs.purge-finished.daily` | `41 3 * * *` | Borra los trabajos terminados de más de `JOBS_RETENTION_DAYS` |
  | `domains.recheck-sweep.hourly` | `29 * * * *` | Re-verifica el TXT de cada dominio personalizado VERIFIED (un trabajo `domains.recheck` por dominio, en su clínica); desactiva los que fallan `DOMAIN_RECHECK_MAX_FAILURES` veces seguidas (SEC-009) |
- **Tablas**: `jobs` y `job_schedules` son de PLATAFORMA, sin RLS (exención
  documentada en `test/rls-catalog.int-spec.ts`): un worker reclama trabajos de
  todas las clínicas. `outbound_messages` es por clínica con RLS forzada: el
  registro de mensajes al paciente (EMAIL, WHATSAPP_LINK, SMS) con el
  destinatario **enmascarado**, plantilla, estado, intentos, error y la cita
  (FK compuesta por tenant). Para EMAIL el transporte sigue siendo
  `email_outbox` (DX-088) con `referenceId` = id del mensaje.
- **Filas de plataforma de `email_outbox`** (`tenantId` NULL; SEC-037,
  DX-144): `dentalix_app` no las ve por RLS ni recibe DELETE nuevo; las borra
  la función `email_outbox_purge_platform` del rol despachador (SENT/FAILED
  anteriores a la retención, por tandas, y nunca de los últimos 7 días). El
  DELETE de ese rol lo acota a `"tenantId" IS NULL` la política RESTRICTIVA
  `email_outbox_dispatcher_delete_platform`.

## Recordatorios de cita por email (DX-026)

Módulo `src/modules/reminders`. Reutiliza la cola y el cron con candado
(DX-085), `outbound_messages`, el email con outbox (DX-088) y el enlace de
confirmación firmado (DX-005); no añade otra cola ni otro transporte.

- **Ajustes por sede** (`location_reminder_settings`, RLS FORCE, FK compuesta
  a la sede): `enabled` (por defecto `false`; sin fila = desactivado) y
  `leadHours`, hasta 3 antelaciones de 1 a 168 h, de mayor a menor. `GET
  /reminder-settings` y `PUT /reminder-settings/:locationId`, **solo ADMIN**
  (otros roles: 403 «Solo un administrador puede ver y cambiar los
  recordatorios.»); validación y 404 de una sede ajena en español.
- **Barrido** `reminders.plan.every-5-min` (`*/5 * * * *`, un ejecutor por
  tick): clínica a clínica, encola `reminders.send-email` por cada cita y
  antelación cuya hora (inicio − antelación) cae en los próximos 10 min, con
  `runAt` en esa hora e `idempotencyKey = reminder:<cita>:<h>h:<inicio ISO>`.
  Un recordatorio atrasado (worker caído) se recupera hasta 1 h después; más
  tarde no se manda (una cita agendada 30 min antes no recibe el de 48 h).
- **Envío** (handler, bajo el tenant del trabajo y RLS; nunca se fía del
  payload, SEC-036): relee cita, paciente y ajustes y **omite con motivo**
  (`NO_EMAIL`, `CANCELLED`, `COMPLETED`, `NO_SHOW`, `RESCHEDULED`, `DELETED`,
  `DISABLED`, `TOO_LATE`: la cita ya empezó o el trabajo corre más de 1 h
  después de la hora del recordatorio, p. ej. tras un worker caído) o reclama la fila única por (cita, antelación, hora
  de inicio) de `appointment_reminders`, emite el enlace de DX-005 (sin
  borrar un «pide llamada»), registra el mensaje en `outbound_messages` y deja
  el email `appointment-reminder` en `email_outbox` con `referenceId` = id del
  mensaje. El registro guarda ese id, nunca el cuerpo. Reprogramar la cita
  cambia la clave: lo de la hora vieja queda `RESCHEDULED` y se recalcula.
- **Email**: fecha y hora en la zona de la sede (horario de la sede o su
  país; 12 h en CO, 24 h en ES), sede, profesional y botón «Confirmar o
  cancelar». Nada clínico (ni motivo ni tratamiento). El enlace va al host de
  plataforma de la clínica, como los de restablecer e invitación (SEC-033,
  `TenantLinkBaseService.forTenant`): `<protocolo>://<subdominio>.<primer
  TENANT_BASE_DOMAINS>/confirmar/<token>`, sin puerto y nunca su dominio
  personalizado (en local, añade `:3001` a mano al abrirlo). Emitirlo
  revoca el enlace anterior de la cita (solo vale el último, como en DX-005).
- **Estado por cita**: `GET /appointments/:id/reminders` (roles de la agenda)
  devuelve los ajustes vigentes de su sede y, por antelación, `SENT` (con
  `sentAt` y la entrega en `email_outbox`), `SKIPPED` (con motivo),
  `SENDING`, `PENDING` (con `dueAt`) o `MISSED`.
- **Demo**: `seed:demo` deja la «Sede principal» con `[48, 2]`. Hace falta un
  worker (`npm run start:dev:all`) para que salgan.

## Dominios personalizados (SEC-009)

Módulo `src/modules/domains` (solo ADMIN). Una clínica registra su dominio
(`POST /domains`), publica el TXT `_dentalix-verify.<host>` con el token y lo
verifica (`POST /domains/:id/verify`); desde ese momento
`TenantResolverService` enruta ese host a la clínica. Solo enruta un dominio
**VERIFIED, vivo y de una clínica viva**; sin caché (cada petición lo lee),
así que desactivar o borrar surte efecto al momento.

- **Sin squatting**: el host solo es único entre los VERIFIED vivos (índice
  parcial `tenant_domains_verified_host_key`). Varias clínicas pueden tenerlo
  en PENDING; lo gana la **primera que verifica** el TXT y los PENDING de las
  demás quedan invalidados (`expiresAt = ahora`, los ven «EXPIRED»). Dos
  verificaciones a la vez del mismo host se ponen en fila (`FOR UPDATE` de sus
  filas): una gana y la otra recibe 409. Registrar un host que otra clínica
  tiene VERIFIED: 409. Dentro de una clínica, un host una sola vez entre los
  vivos (`tenant_domains_tenant_host_key`).
- **Caducidad**: un PENDING se puede verificar durante **72 h**
  (`expiresAt`); después es `EXPIRED`: no bloquea a nadie, verificarlo da 410
  y volver a registrarlo lo sustituye (token nuevo). `GET /domains` devuelve
  el estado efectivo: `PENDING`, `EXPIRED`, `VERIFIED` o `DISABLED`.
- **Eliminar**: `DELETE /domains/:id` (204; soft delete; id no UUID → 400;
  de otra clínica → 404), en cualquier estado. Deja de enrutar y libera el
  host. Verificar y eliminar quedan en `audit_events` (recurso
  `TENANT_DOMAIN`).
- **Re-verificación periódica** (cola de DX-085): cada hora
  `domains.recheck-sweep.hourly` encola un `domains.recheck` por dominio
  VERIFIED, en la clínica del dominio, con clave por (dominio, ronda). Si el
  TXT con el token sigue publicado, `failedChecks` vuelve a 0; si no, suma uno
  y al llegar a `DOMAIN_RECHECK_MAX_FAILURES` (default **3**, 1..20) seguidos
  pasa a **DISABLED**: deja de enrutar y queda `disabledAt`. Un DNS que no
  responde (SERVFAIL, timeout) se reintenta con el backoff de la cola y, si
  sigue sin responder en el último intento, **cuenta como fallo** (fail-closed:
  quien compre el dominio no puede esquivar la desactivación haciendo fallar
  su DNS). Un DISABLED se puede volver a verificar (mismo token) o eliminar.
  La desactivación la hace el sistema, sin usuario: `audit_events` exige un
  actor (CHECK `audit_events_actor_check`), así que queda en el log
  (`domains.disabled`, con ids, sin el host) y en la propia fila
  (`disabledAt`, `failedChecks`, `lastCheckedAt`).
- **DNS inyectable**: puerto `DNS_RESOLVER` (`NodeDnsResolver` en producción);
  los tests lo sustituyen por `FakeDns` (y el reloj por `DomainClock`).

## Despliegue: roles de la BD (DX-113)

Requiere **PostgreSQL ≥ 16** (las migraciones usan `GRANT … WITH SET`, y
las comprobaciones, `pg_auth_members.set_option`). En un Postgres gestionado
(RDS, Cloud SQL…) nadie de la aplicación es superusuario ni tiene BYPASSRLS. Hay dos roles con login y tres NOLOGIN que
crean las migraciones; el job `owner-nosu` de la CI despliega así desde cero
en cada PR (migraciones, seed de referencia, `seed:demo`, comprobación de
FORCE y `npm run test:owner-nosu`).

| Rol | Conexión | Privilegios mínimos | Nunca |
|-----|----------|---------------------|-------|
| owner (p. ej. `dentalix_owner`) | `DIRECT_URL`: solo `prisma migrate deploy`, `prisma db seed` y `audit:purge` | `LOGIN`, `CREATEROLE` (crea `dentalix_app` y los roles NOLOGIN de abajo), dueño de la base (`CREATE` para las extensiones *trusted* `unaccent`, `btree_gist`, `pg_trgm`, `btree_gin`) y del esquema `public` (lo es por `pg_database_owner`) | `SUPERUSER`, `BYPASSRLS`, `CREATEDB`, `REPLICATION`; ni lo usa la API |
| `dentalix_app` (nombre fijo: lo citan las migraciones) | `DATABASE_URL`: la API y `seed:demo` | `LOGIN`, `CONNECT`, `USAGE` en `public`, `SELECT/INSERT/UPDATE/DELETE` en tablas y `USAGE/SELECT` en secuencias (privilegios por defecto del owner) y `EXECUTE` en las funciones que le conceden las migraciones (búsqueda de pacientes, despachador de email, particiones de auditoría, membresías en otras clínicas) | dueño de tablas, `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB` |
| `dentalix_patient_search` (DX-043) | NOLOGIN | dueño de `dx_patient_search_*`; `SELECT` de 5 columnas de `patients` y su política | `LOGIN`, `BYPASSRLS`, miembros con `SET`/`INHERIT` |
| `dentalix_email_dispatcher` (DX-113) | NOLOGIN | dueño de `email_outbox_claim/_settle/_enqueue_platform` y, desde DX-144, de `email_outbox_enqueue_platform_capped/_platform_allowed/_purge_platform`; `SELECT/INSERT/UPDATE/DELETE` de `email_outbox` con su política permisiva y, para DELETE, una RESTRICTIVA que lo limita a filas de plataforma | `LOGIN`, `BYPASSRLS`, miembros con `SET`/`INHERIT`, DELETE sin su política restrictiva |
| `dentalix_membership_lookup` (DX-143) | NOLOGIN | dueño de `dx_user_has_other_active_memberships`; `SELECT` de 3 columnas (`userId`, `tenantId`, `deletedAt`) de `clinic_memberships` y su política de solo `SELECT` | `LOGIN`, `BYPASSRLS`, miembros con `SET`/`INHERIT` |

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
#    Antes de crear nada aborta si el clúster ya es de otro owner (un owner por
#    clúster, ver «Roles del clúster» abajo).
psql "${DIRECT_URL%%\?*}" -v ON_ERROR_STOP=1 -v app_password="$(openssl rand -hex 24)" \
  -f docker/prod/create-app-role.sql
# 3. Como el owner, en un job previo al despliegue (no en el arranque de cada réplica):
npx prisma migrate deploy && npx prisma db seed
# 4. Comprobación tras el despliegue (DX-134). Sale con 0 si todo está bien,
#    1 (y las listas) si no, 2 si no pudo comprobarlo. Si no sale con 0, NO des
#    el despliegue por bueno. Comprueba en public:
#      tables        tablas con RLS activada y sin FORCE;
#      rls_disabled  tablas de clínica sin RLS (salvo tenant_domains) y
#                    particiones sin RLS de una tabla con RLS;
#      members       miembros de los roles NOLOGIN del clúster que no son el
#                    owner de la base, o el owner con SET/INHERIT;
#      dispatcher_delete  tablas donde dentalix_email_dispatcher tiene DELETE
#                    sin la política restrictiva `"tenantId" IS NULL` (DX-144).
npm run db:check-force
```

**Si `db:check-force` falla con `tables`**: una migración que
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
y repite la comprobación. Con `rls_disabled`, alguien creó una tabla o una
partición fuera de las migraciones (o una migración olvidó la RLS):
`ENABLE` + `FORCE ROW LEVEL SECURITY` y su política, o una migración que lo
haga. Con `members`, alguien añadió un miembro a un rol del clúster: retíralo
como admin (`REVOKE <rol> FROM <miembro>`) y averigua por qué; mientras
estuvo, pudo leer `patients`/`email_outbox`/`clinic_memberships` de todas las bases del clúster.
Con `dispatcher_delete`, alguien concedió DELETE a `dentalix_email_dispatcher`
sobre esa tabla, o quitó la política `email_outbox_dispatcher_delete_platform`
de `email_outbox`: retira el DELETE (`REVOKE DELETE ON "<tabla>" FROM
dentalix_email_dispatcher`) o repón la política como en
`20261017231200_dx144_platform_email_quota`. La CI la ejecuta en los jobs de integración y
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
  `test/owner-nosu/migrations-data.owner-spec.ts`. **Ojo con los triggers del
  resumen de la cartera (DX-155)**: escribir en `patients`, `appointments`,
  `treatment_plans`, sus ítems o aceptaciones, `payments`, `payment_plans` o
  `installments` recalcula `patient_ledgers` leyendo todas esas tablas; quita
  FORCE también a `patient_ledgers` y a ellas (como hace
  `20261017233000_dx155_patient_ledgers`), o el refresco falla («no se ven N
  de M pacientes…») y la migración con él.
- **Añadir o validar una FOREIGN KEY también cuenta como leer filas** (DX-134):
  `ALTER TABLE … ADD … FOREIGN KEY` (sin `NOT VALID`), `ADD COLUMN … DEFAULT …
  REFERENCES` o `VALIDATE CONSTRAINT` necesita `NO FORCE` **en la tabla hija y
  en la referenciada** (las que tengan FORCE) en la misma transacción, y
  `FORCE` en las dos al final. La validación lee las dos tablas con la RLS del
  owner, que no ve ninguna fila de clínica:
  - FORCE en la hija: **acepta la FK aunque haya filas huérfanas**, en
    silencio (los `CHECK` y los índices únicos sí las ven);
  - FORCE en la referenciada: la FK **falla con datos válidos**. La CI migra
    con las tablas vacías y no lo ve; producción, sí.

  Con la regla completa, la migración falla de forma ruidosa si hay huérfanas
  y entra si no las hay. Lo demuestra
  `test/owner-nosu/fk-under-force.owner-spec.ts`, y el lint
  `test/migrations/fk-under-force.spec.ts` (en `npm test`) falla si una
  migración nueva lo incumple por cualquiera de los dos lados. No cuenta una
  hija creada en la misma migración (está vacía). Las migraciones antiguas que
  ya lo hacían están en su allowlist, comentadas, y no se editan.
- **Migraciones antiguas**: las de datos van entre una pareja
  `…_dx113_unforce_<x>` / `…_dx113_reforce_<x>` que quita y devuelve FORCE
  solo a las tablas que tocan. En una base ya migrada las parejas se aplican
  seguidas y no cambian nada (Prisma aplica migraciones intercaladas sin pedir
  reset). Tres migraciones solo podían arreglarse por dentro (mismo `NO
  FORCE`/`FORCE` en su transacción; el esquema resultante es idéntico):
  `20261016170000_data_processing_consents`,
  `20261017113000_payments_civil_day_noon` y `20261017120000_email_outbox`.
  `migrate deploy` no mira el checksum, pero en una base de desarrollo ya
  migrada `prisma migrate dev` dirá *«was modified after it was applied»* y
  propondrá un reset. **No lo aceptes**: actualiza el checksum (no toca datos)
  y sigue con `migrate deploy`:

  ```bash
  for m in 20261016170000_data_processing_consents 20261017113000_payments_civil_day_noon 20261017120000_email_outbox; do
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
- **Roles del clúster: un owner por clúster** (DX-134). `dentalix_app`,
  `dentalix_patient_search`, `dentalix_email_dispatcher` y
  `dentalix_membership_lookup` son del clúster, no de la base, y **ADMIN OPTION sobre un rol equivale a poder darse SET**: con
  ella, un owner puede hacer `SET ROLE dentalix_patient_search` en cualquier
  base del clúster y leer `patients` (o `email_outbox`, o
  `clinic_memberships`) de todas las clínicas
  por la política `USING (true)` de ese rol. Por eso:
  - **Un owner por clúster** (o un clúster por despliegue). El mismo owner
    puede tener varias bases en él; para aislar entornos (producción frente a
    staging) o aplicaciones, usa clústeres distintos.
  - El owner sin superusuario que crea los roles queda como su único miembro,
    solo con ADMIN (PG16: sin SET ni INHERIT); las migraciones se dan SET un
    momento para traspasar las funciones y lo retiran.
  - `create-app-role.sql` (paso 2, antes de migrar) aborta sin crear nada si
    esos roles ya tienen otro miembro: *«Este clúster ya tiene el rol … de
    otro owner (miembros: …). Un owner por clúster: migra esta base con ese
    owner o usa un clúster distinto»*. La migración también se niega
    (*«tiene miembros inesperados»*). Darle ADMIN OPTION a un segundo owner
    **no** lo arregla: es justo lo que la restricción evita.
  - Si los roles los creó un superusuario (p. ej. el `dentalix` del docker
    local) y el clúster es solo de este owner, `create-app-role.sql` pide que
    el admin ejecute antes `GRANT dentalix_patient_search,
    dentalix_email_dispatcher, dentalix_membership_lookup TO <owner> WITH ADMIN OPTION, INHERIT FALSE, SET
    FALSE`.
  - `db:check-force` (paso 4) vuelve a comprobar las membresías en cada
    despliegue: un miembro añadido después sale en `members`.

  Lo prueba `test/owner-nosu/shared-cluster.owner-spec.ts`.
- **En local**, con un Postgres aparte (los roles son del clúster; p. ej.
  `docker run -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:16`): crea
  el owner y la base como en el paso 1, aplica los pasos 2 a 4, y
  `DIRECT_URL=<owner> DATABASE_URL=<app> OWNER_NOSU_ADMIN_URL=<admin>/postgres
  npm run test:owner-nosu`. Los specs crean y borran sus propias bases y, el
  de clúster compartido, un segundo owner y un intruso con nombre único.

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
