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
   las contraseñas de base de datos de ejemplo (`changeme`, `dentalix_app`…),
   y exige `STORAGE_DRIVER=s3` con su bucket (ver «Ficheros en un bucket S3»).
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
   | RECEPTION | `recepcion.norte@demo.dentalix.app` (solo Sede Norte — DX-089) |

   Contenido: 2 sedes con horario (la principal con el horario por defecto del
   registro; "Sede Norte" con el suyo), catálogo por defecto con tarifas en la moneda de la sede demo (hoy COP; la demo con sedes de varios países llega con DX-335),
   25 pacientes ficticios (correos `@example.com`) con historias clínicas,
   evoluciones (una corregida con una adenda — DX-038; tres con diagnóstico CIE-10 — DX-212) y odontograma (un hallazgo anulado con motivo y una paciente infantil con dentición mixta, registros temporales y de otro origen — DX-120), 5 tipos de cita con duración y color (DX-121), las 6 plantillas de evolución de ejemplo con dos evoluciones redactadas con ellas («Resina» y «Profilaxis») y ligadas a las últimas citas atendidas (DX-170), las 5 indicaciones postoperatorias de ejemplo con `POI-EXO` vinculada a «Exodoncia simple», la sede principal con teléfono y una entrega impresa de ayer (o del último día con consulta) — DX-222, ~90 citas desde el lunes de la semana pasada hasta
   el sábado de la próxima en distintos estados (las de valoración, limpieza, endodoncia, urgencia y ortodoncia con su tipo), bloqueos de agenda (vacaciones de la segunda dentista de lunes a viernes de la semana siguiente a la próxima, en todas las sedes, y el almuerzo del equipo en la sede principal el próximo día laborable, que deja agendar con aviso) y 3 «Pendientes por agendar» abiertos (las dos cancelaciones o no-shows más recientes y un alta manual urgente; las más antiguas quedan descartadas con motivo) — DX-122, y la cita agendada más lejana de la primera dentista en la sede principal marcada «Adelantar si hay hueco», que sale como candidata en «Ocupar este hueco» al cancelar una cita anterior (DX-210), la rotación de la segunda dentista entre las dos sedes (lunes, miércoles y viernes en la principal; martes y jueves en la Norte, con sus citas dentro) y una excepción el lunes que vuelve de vacaciones: no va a la principal y cubre la Norte de 7:00 a 12:00 — DX-233, planes de tratamiento en todos
   sus estados (con un presupuesto en borrador con descuentos —uno del 10 % del
   odontólogo y otro del 15 % de la administración con su motivo, que salen en
   el informe de descuentos (DX-204)—, listo para presentar, y otro aceptado con la firma del paciente — DX-012; y dos opciones A/B de Carolina Duque —implante o puente— presentadas hace 9 días y sin cita futura, que salen en «Presupuestos por seguir» — DX-040), abonos en la moneda de la sede de los últimos 60 días en ambas sedes, cada uno con su recibo de caja numerado por sede (`PRI-000001`…, `NOR-000001`…; el abono duplicado anulado conserva su número y sale «ANULADO» — DX-136), un plan de
   pagos con cuotas e inventario por sede con ítems bajo el stock mínimo. Varios planes se abrieron hace 20, 40, 75 y 100 días (`openedDaysAgo`), así que la cartera (DX-145) tiene deudores en todos los tramos en las dos sedes. Dos de ellos tienen gestiones de cobro y uno un compromiso de pago abierto a 5 días (DX-150): se ven en la cartera, en el bloque «Cobranza» de su ficha y con el chip «Saldo vencido» en sus citas. Recepción tiene en la sede principal la caja por turno de hoy (DX-027): la de la mañana cerrada con un arqueo que no cuadra por 2.000 (con su motivo) y la de la tarde abierta con su fondo y un cobro; los abonos históricos quedan sin caja. «Recepción Norte» está restringida a la Sede Norte (DX-089): al entrar con ella la agenda, la caja, el inventario y la cartera muestran solo esa sede, y la principal da 403 (ver «Personal restringido a sedes»).

   - **Idempotencia**: si el tenant `demo` ya existe, no hace nada (solo vuelve a
     imprimir las credenciales). `--reset` retira la demo anterior **en blando**
     (tenant, membresías y usuarios `@demo.dentalix.app` con `deletedAt`, como el
     resto del producto) y la crea de nuevo; úsalo cuando la agenda "envejezca".
     Si una corrida falla a medias, la demo incompleta se retira sola.
   - **Nunca toca lo ajeno**: un tenant `demo` que no creó el seed (sin
     `admin@demo.dentalix.app` como ADMIN vivo) aborta la corrida, con o sin
     `--reset`; y si algún usuario `@demo.dentalix.app` es miembro vivo de otra
     clínica, tampoco se retira nada.
   - **Determinista**: sin azar; todo depende solo de la fecha de hoy (en la zona
     de la sede demo, hoy UTC-5 fijo; con DX-335 la región de la demo será
     configurable). Moneda, zona horaria y país dependen siempre de la sede.
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
  nombres ni datos clínicos (minimización de datos personales). Además, cualquier campo
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

Registro de quién vio o cambió datos clínicos y financieros (trazabilidad
que piden las normas de protección de datos y de historia clínica), en la tabla `audit_events` (módulo `src/modules/audit`).

- **Qué se audita**: los endpoints marcados con `@Audit({ action, resource,
  resourceId?, patient? })`: pacientes, historia clínica, evoluciones,
  odontograma, periodontograma, consentimientos, autorizaciones de datos,
  recetas, planes de tratamiento (presupuesto y aceptación), abonos y
  anulaciones, planes de cuotas, estado de cuenta y el login (correcto y
  fallido). La lista exacta la fija `src/modules/audit/audit-coverage.spec.ts`.
  No se audita la búsqueda `GET /patients` ni la propia lectura del registro.
- **Personal y cuenta (DX-359)**: invitar (`CREATE STAFF_INVITATION`, con el
  rol), reenviar (`INVITATION_RESENT`), retirar o sustituir una invitación
  (`VOID`, `INVITATION_REVOKED`/`INVITATION_REPLACED`), aceptarla con
  cualquier cuenta (`CREATE STAFF_MEMBER`, `INVITATION_ACCEPTED`, actor = el
  propio miembro), cambiar rol, sedes, registro profesional o especialidad
  (`STAFF_UPDATED`, con `staffAccess.before`/`after` de lo que cambió; el
  nombre, solo en `changedFields`; sin evento si nada cambia), desactivar y
  reactivar (`STAFF_DEACTIVATED`/`STAFF_REACTIVATED`, con `statusChange`), el
  alta de la clínica (`CREATE CLINIC`, `CLINIC_REGISTERED`), el nombre propio
  (`OWN_NAME_CHANGED`) y la contraseña propia (`PASSWORD_CHANGE`,
  `SESSIONS_REVOKED`: solo el hecho). Estos eventos los escribe el
  repositorio en la **misma transacción** que el cambio (`writeAuditEvent`):
  sin cambio no hay evento y sin evento no hay cambio. Nunca guardan
  contraseñas, hashes, tokens de invitación o verificación, emails ni
  nombres. El alta del MFA del superadmin (`MFA_ENROLLMENT_STARTED`,
  `MFA_ENABLED`) y su cambio de contraseña con sesión de plataforma van a
  `platform_audit_events` (sin clínica), con la metadata vacía.
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

## Hueco libre → candidatos (DX-210)

- `GET /appointments/openings/:locationId/candidates?start&end&providerId?`
  lista quién puede ocupar un hueco libre de la sede: pendientes OPEN
  (DX-122) cuya duración cabe y que no son quien liberó ese hueco, y citas
  SCHEDULED/CONFIRMED marcadas «Adelantar si hay hueco» (`wantsEarlier`) de
  un día civil posterior (zona de la sede), del profesional del hueco si se
  indica. Orden: URGENT, resto de pendientes, citas (la más lejana primero)
  y, a igualdad, la más antigua; tope de 50. RECEPTION y ADMIN; DENTIST solo
  con `providerId` = él mismo; ASSISTANT 403.
- `POST /appointments/openings/:locationId/offers` registra una oferta
  (`WA_ME` o `PHONE`) en `waitlist_offers` (RLS FORCE, FK compuestas) y la
  audita (`WAITLIST_OFFER`). Por WhatsApp solo si el paciente dio el permiso
  de WhatsApp (`whatsappOptInAt`, con fecha y origen), no tiene baja de avisos
  ni canal «Ninguno» (DX-128) y tiene móvil válido; si no, se le llama (el
  candidato trae `whatsappBlockedReason`). Tope de
  `WAITLIST_OFFERS_PER_PATIENT_PER_DAY` (2) por paciente y día civil de la
  sede, contado bajo un candado por paciente: la tercera da 409 «Ya se le
  ofrecieron 2 huecos hoy». `PATCH /appointments/openings/offers/:id` anota la
  respuesta una vez; el candidato trae `pendingOfferId` (la última oferta de
  ese hueco sin respuesta) para anotarla desde el panel.
- Asignar: un pendiente con `POST /waitlist/:id/schedule`; una cita marcada
  con `PATCH /appointments/:id/opening` (solo a un hueco anterior a la cita;
  reglas de reagendar: pasado, horario,
  bloqueos y solapes; la marca se apaga en la misma sentencia condicional, así
  que dos movimientos a la vez dan uno y un 409). Dos asignaciones al mismo
  hueco: la EXCLUDE por profesional deja una y la otra recibe 409.
- El texto del `wa.me` lo arma la web solo con nombre de pila, fecha, hora,
  sede y profesional (nunca motivo ni tratamiento).

## Horario de cada profesional por sede (DX-233)

- **Modelo** (migración `20261020220100_dx233_provider_schedules`):
  `provider_schedules` (un horario vivo por profesional y sede: único
  PARCIAL), `provider_schedule_ranges` (tramos semanales: día 0–6, minutos de
  pared de la sede), `provider_schedule_overrides` (excepción por fecha civil
  de una sede, una viva por profesional, sede y fecha) y
  `provider_schedule_override_ranges` (sus tramos; sin tramos = «no
  trabaja»). RLS FORCE y FK compuestas por tenant a la sede y entre tablas;
  `providerId` sin FK, como `appointments` (la API exige un miembro activo
  DENTIST o ADMIN). CHECK: minutos múltiplos de 5, `0 <= inicio < fin <=
  1440`. EXCLUDE: dos tramos vivos del mismo profesional no se solapan el
  mismo día de la semana (o la misma fecha, en las excepciones) en ninguna
  sede. Todo se retira en blando. Las ausencias siguen siendo bloqueos
  VACATION (DX-122).
- **Regla** (`domain/provider-availability.ts`, `providerWorksAt`): sin
  horario configurado = sin restricción (como una sede sin horario). Con
  horario, la cita cabe completa en un tramo del profesional en ESA sede ese
  día, en la zona vigente de la sede (cambio de hora incluido); la excepción
  de la fecha prevalece sobre el semanal de esa sede. Nunca cruza medianoche.
  El horario de la sede se sigue comprobando aparte (422).
- **Endpoints**: `GET/PUT /providers/:providerId/schedule` (todas sus sedes
  en un cuerpo; lista vacía = sin horario), `GET/POST/DELETE
  /providers/:providerId/schedule-overrides` (POST crea o reemplaza la de esa
  sede y fecha, de hoy a dos años), `GET /schedule/roster?weekStart&days&locationId`
  (cuadrante profesional × día; con `locationId`, `worksAtLocation` y
  `locationRanges` para sombrear la agenda) y `GET/PUT /schedule/settings`
  (`strictProviderSchedule`). Leen los cuatro roles de agenda; escribe ADMIN.
  Validación en español: ≤ 7 tramos por día y sede, sin solapes, y ningún
  tramo el mismo día en dos sedes (también contra las excepciones). La
  validación y la escritura van en la misma transacción con un candado por
  profesional.
- **Agenda**: crear o mover una cita fuera del horario del profesional la deja
  agendar con el aviso en `warnings` y `warningCodes: ["PROVIDER_OFF_SCHEDULE"]`
  (`warningCodes[i]` es el código de `warnings[i]`; los bloqueos que dejan
  agendar llevan `SCHEDULE_BLOCK`). Con `tenants.providerScheduleStrict`
  (modo estricto), 409 en español. «Buscar hueco» cruza el horario de la sede
  con el del profesional cada día; «Ocupar este hueco» (DX-210) deja fuera a
  quien caería fuera del horario de su profesional y trae
  `providerOffSchedule`.
- **Sedes permitidas (DX-089)**: a un profesional acotado a ciertas sedes no
  se le pone horario semanal ni excepciones en las demás (400 en español;
  quitarle una sede, sin tramos, siempre se puede). Un miembro acotado que lee
  el horario, las excepciones o el cuadrante solo ve sus sedes, y en el
  cuadrante solo a quien atiende en alguna de ellas; un `locationId` fuera de
  las suyas es 403, como en la agenda. Con `locationId`, quien no atiende en
  esa sede sale con `worksAtLocation: false`. El aviso de una cita sin
  cabecera mira la sede donde se escribe (`writeLocationId`).
- **Auditoría**: `PROVIDER_SCHEDULE` con `reason`
  `PROVIDER_SCHEDULE_REPLACED`, `PROVIDER_SCHEDULE_OVERRIDE_SET`,
  `PROVIDER_SCHEDULE_OVERRIDE_DELETED` o `PROVIDER_SCHEDULE_SETTINGS`, autor y
  `scheduleChange: { before, after }` con los tramos (sedes, días o fechas y
  minutos; nada de pacientes).

## Alertas médicas en la agenda (DX-247)

- **Solo banderas** (`medicalAlerts`, `domain/medical-alert-flags.ts`): cada
  cita de `GET /appointments` y cada persona de `GET /appointments/in-clinic`
  traen `hasCriticalAlert`, `requiresPremedication` (profilaxis antibiótica),
  `anamnesisStatus` (`CURRENT` / `EXPIRED` / `MISSING`: «Sin anamnesis» no es
  «sin alertas»), `alerts` (códigos de las banderas derivadas en el orden del
  banner de la ficha; `alergiaMarcada` = otra alergia marcada como alerta, sin
  el alérgeno) y `anamnesisReviewedAt`. Nunca alergias, condiciones,
  medicamentos ni notas (Ley 1581 / RGPD); los leen los cuatro roles que ven
  la agenda. Por lote: una lectura de la vigencia y UNA consulta (versión
  vigente + última confirmación por paciente, con `LATERAL ... LIMIT 1` sobre
  `mhv_tenant_patient_version_key` y `medical_history_reviews_tenant_patient_idx`).
  `GET /appointments/:id` sigue sin banderas (la web usa la cita de la lista).
- **Ficha**: `GET /patients/:patientId/medical-alerts` (los cuatro roles): las
  mismas banderas con `validityMonths`, `anamnesisExpiresAt` y `lastReview`
  (`UPDATED` o `NO_CHANGES`, fecha y quién). 404 para un paciente de otra
  clínica.
- **Vigencia** (`tenants.anamnesisValidityMonths`, 12 por defecto, CHECK
  1..60): la anamnesis caduca a los N meses de calendario de la última versión
  o de la última confirmación, la más reciente. `GET /medical-history/settings`
  (cuatro roles) y `PUT` (solo ADMIN, 400 fuera de 1..60), auditado como
  `MEDICAL_HISTORY` sin paciente con `reason` `ANAMNESIS_VALIDITY_SETTINGS` y
  `statusChange` `MONTHS_12 → MONTHS_6`.
- **«Sin cambios hoy»**: `POST /patients/:patientId/medical-history/no-changes`
  (DENTIST, ASSISTANT, ADMIN; recepción 403) guarda en
  `medical_history_reviews` quién, en qué sede y cuándo (hora del servidor de
  BD, trigger) sobre la versión vigente; no crea una versión. Sin anamnesis,
  409. Queda en la auditoría (`MEDICAL_HISTORY`, `UPDATE`, `reason`
  `NO_CHANGES_CONFIRMED`, el paciente y el id de la confirmación; nada
  clínico). Tabla con RLS FORCE, FK compuestas al paciente y a
  `(tenantId, patientId, id)` de la versión (índice
  `mhv_tenant_patient_id_key`, creado CONCURRENTLY) e inalterable como la
  historia (DX-038).
- **Seed demo**: Jorge Eduardo Ramírez (prótesis valvular) requiere
  premedicación y entra primero en «En clínica» hoy; Ana María Zapata tiene la
  anamnesis de hace 14 meses (caducada); la de Gustavo Ríos es de hace 13
  meses con «Sin cambios hoy» de la segunda dentista; quince pacientes no
  tienen anamnesis (p. ej. Daniela Montoya).

## Anamnesis previa a la cita por enlace (DX-099)

El paciente responde su anamnesis desde el móvil antes de la cita y un
profesional la revisa; la historia clínica no cambia hasta que se acepta.
Módulo `medical-history-submissions`; migraciones
`20261023160000_dx099_enums` y
`20261023160100_dx099_medical_history_submissions`.

- **Tabla `medical_history_submissions`**: paciente, cita opcional, sede de
  la bandeja (la de la cita o la de escritura de la sesión), `tokenHash`
  (SHA-256 del token de 32 bytes; el token solo viaja en la URL y en la
  respuesta que lo crea), `expiresAt`, `revokedAt`, `status`
  (`PENDING_PATIENT`, `SUBMITTED`, `ACCEPTED`, `REJECTED`, `EXPIRED`),
  `questionnaireVersion`, `answers` (JSONB, ≤ 64 KB), revisor, fecha, motivo
  del rechazo y `resultingVersionId`. RLS FORCE, FK compuestas por tenant
  (paciente, cita del MISMO paciente, sede y versión resultante del MISMO
  paciente), CHECK de coherencia por estado y sin borrado duro (DELETE y
  TRUNCATE solo superusuario). El trigger `medical_history_submissions_guard`
  impide reescribir las respuestas y tocar un envío revisado o caducado. Un
  enlace sin usar cuya fecha pasó se ve `EXPIRED` sin barrido.
- **Origen de la versión**: `medical_history_versions.source` (`STAFF` por
  defecto, `PATIENT_FORM` al aceptar el formulario; autor = quien revisa). Va
  en `MedicalHistoryDto.source`.
- **Cuestionario** (`domain/anamnesis-questionnaire.ts`, versión
  `2026-10-v1`): fijo y versionado en código; mismos bloques y `codigo` que la
  HC del personal (alergias, enfermedades, medicación y anticoagulantes,
  hábitos, embarazo y cirugías), preguntas Sí/No/No sé con seguimiento. Al
  aceptar, «Sí» = lo declarado, «No» = nada, «No sé» = lo que ya había; lo
  que el formulario no pregunta (antecedentes odontológicos, signos vitales,
  notas) se conserva. Toda alergia declarada entra como alerta; «Sí» a
  anticoagulantes añade el medicamento y enciende la bandera aunque no diga
  cuál (`deriveSafetyFlags` reconoce ahora `anticoagul`/`antiagregant`).
- **Personal**:
  - `POST /patients/:patientId/medical-history/requests` (los 4 roles;
    `appointmentId` opcional): un solo uso, caduca a los 7 días o al inicio de
    la cita (lo que llegue antes) y anula el enlace anterior que aún esperaba.
    Devuelve la URL una única vez y `whatsapp` (`phone` + `text` para
    `wa.me`: saludo, clínica y enlace; nada clínico) o el motivo de no tenerlo
    (sin móvil válido, baja de envíos de DX-128). Cita de otro
    paciente 400, empezada o no agendada 422, de otra sede 403. Sin
    autorización SENSITIVE_HEALTH vigente y sin política publicada, 409.
  - `GET /patients/:patientId/medical-history/requests` (los 4 roles): los
    últimos 10 envíos con su estado, sin respuestas.
  - `GET /medical-history/submissions?status=SUBMITTED` (bandeja,
    ADMIN/DENTIST/ASSISTANT): en las sedes del alcance de la sesión (SEC-045);
    las más antiguas primero. `GET …/summary` → `{ submitted }` (contador del
    menú).
  - `GET /medical-history/submissions/:id` (ídem): respuestas, versión
    vigente, propuesta, banderas resultantes y **diferencias** (`ADDED`,
    `REMOVED`, `CHANGED`; los «Sí» primero; sin versión previa, todo nuevo).
  - `POST …/:id/accept` y `POST …/:id/reject` (`reason` 3–500): solo ADMIN y
    DENTIST; el resto 403 «Solo un odontólogo o un administrador puede aceptar
    o rechazar la anamnesis.». Aceptar crea **exactamente una** versión en la
    misma transacción que el cambio de estado (fila bloqueada `FOR UPDATE` y
    candado por paciente de DX-247); con `medicalHistory` guarda los ajustes
    del profesional en vez de la propuesta. Ya revisada o aún sin enviar, 409.
  - `POST …/:id/revoke` (los 4 roles): anula un enlace sin usar.
- **Público** (sin sesión, tenant por host, `@RateLimit('anamnesis',
  'anamnesis-token')`: por IP y por token, un balde por ruta):
  `GET /public/medical-history/:token` devuelve solo el cuestionario, la marca
  de la clínica y el nombre de pila (nunca apellidos, documento ni datos de
  salud anteriores) y, si falta SENSITIVE_HEALTH, el texto versionado de la
  política (DX-037). `POST` guarda las respuestas una vez (transición
  condicional); exige la casilla de veracidad (400) y, si hacía falta, la
  autorización (422; se guarda con canal `PATIENT_LINK`, sin usuario). Token
  malformado, desconocido o de otra clínica 404; caducado, anulado o ya usado
  410 «Este enlace ya no es válido, contacte con su clínica.».
- **Auditoría** (`MEDICAL_HISTORY_SUBMISSION`): crear el enlace
  (`ANAMNESIS_LINK_CREATED`), ver la revisión, aceptar (`ANAMNESIS_ACCEPTED`),
  rechazar (`ANAMNESIS_REJECTED`) y anular (`ANAMNESIS_LINK_REVOKED`), con el
  paciente; el envío del paciente (`ANAMNESIS_SUBMITTED`, origen `LINK`) y su
  autorización (`DATA_CONSENT`, `ANAMNESIS_LINK`) sin actor, en la misma
  transacción (`audit_events_actor_check` admite solo esas dos). Nunca la URL,
  el token, las respuestas ni el motivo.
- **Seed demo**: Natalia Vargas envió su cuestionario (alergia a la
  penicilina, asma, anticonceptivo, alcohol los fines de semana) y queda en
  «Anamnesis por revisar» de la sede principal.

## Flujo del paciente en la clínica (DX-200)

- **Estados nuevos** de la cita: `ARRIVED` (llegó, en espera), `IN_CHAIR`
  (en sillón) y `READY_FOR_CHECKOUT` (listo para cobrar), con sus horas
  `arrivedAt`, `seatedAt` y `readyForCheckoutAt` (UTC, reloj del servidor;
  null en las citas antiguas). Migraciones aditivas: `ADD VALUE` en su propio
  fichero, columnas nullables y la CHECK `appointments_flow_times_check` (cada
  estado lleva su hora y en orden). Cuentan como **en curso**: ocupan el hueco
  (EXCLUDE), nunca son no-show, no reciben recordatorios (`IN_CLINIC` en el
  motivo de omisión), impiden archivar al paciente, salen en las citas
  afectadas por un bloqueo y sacan al paciente de «Presupuestos por seguir».
- **Transiciones** (`PATCH /appointments/:id` con `status`,
  `domain/patient-flow.ts`): `ARRIVED` solo desde `SCHEDULED`/`CONFIRMED` y el
  día de la cita en la zona de la sede (RECEPTION, ASSISTANT, ADMIN);
  `IN_CHAIR` solo desde `ARRIVED` y `READY_FOR_CHECKOUT` solo desde
  `IN_CHAIR` (DENTIST, ASSISTANT, ADMIN); la salida a `COMPLETED` (o
  `CANCELLED` si se fue sin pasar al sillón) desde el flujo, el mostrador
  (RECEPTION, ASSISTANT, ADMIN). Desde el flujo nunca `NO_SHOW`. Un salto
  imposible es 409 en español; un rol sin permiso, 403. Las transiciones
  entre los estados de siempre no cambian (`COMPLETED` sigue disponible). El
  cambio va condicionado al estado leído: dos a la vez, uno gana y el otro
  recibe 409.
- **«Deshacer llegada»**: `POST /appointments/:id/undo-arrival` (RECEPTION,
  ASSISTANT, ADMIN), solo desde `ARRIVED`: vuelve al estado previo
  (`preArrivalStatus`) y borra `arrivedAt` en una sentencia condicional.
- **Auditoría**: cada paso deja un `audit_event` (`APPOINTMENT`, `UPDATE`) con
  `reason` `PATIENT_FLOW` o `ARRIVAL_UNDONE` y `status: { from, to }`.
- **Panel «En clínica»**: `GET /appointments/in-clinic?date=YYYY-MM-DD` de la
  sede de `X-Location-Id` (sin sede, 400; sede ajena, 400). Día civil en la
  zona de la sede (por defecto, hoy allí). Grupos `waiting`, `inChair` y
  `readyForCheckout` con `minutesInStatus`, `waitedMinutes` y `punctuality`
  (`ON_TIME` a la hora o antes, `LATE` hasta 5 min tarde, `VERY_LATE`
  después), calculados con el reloj del servidor. Solo nombre, profesional y
  horas (nada clínico). DENTIST: solo sus pacientes (`scope: MINE`); el
  resto, toda la sede. Índice parcial
  `appointments_tenant_location_in_clinic_idx`.
- Seed demo: en la sede principal, hoy, dos pacientes en espera (una antes de
  su hora, otra 3 min tarde), una en el sillón y otra lista para cobrar
  (dentro del horario de hoy; con la sede cerrada, ninguna).

## Producción atribuible: quién realizó cada ítem, dónde y cuándo (DX-050)

- **Columnas** de `treatment_plan_items` (migración
  `20261023160000_dx050_plan_item_attribution`, aditiva): `performedById` (el
  usuario, como `appointments.providerId`), `performedByMembershipId` (su
  membresía en esta clínica), `performedLocationId` y `completedAt`. FK
  COMPUESTA `("tenantId","performedByMembershipId","performedById")` →
  `clinic_memberships("tenantId","id","userId")`: quien lo realizó es miembro de
  la MISMA clínica y la membresía es la de ese usuario; la sede, FK compuesta a
  `locations`. CHECK: usuario y membresía van juntos, y un ítem que no está
  DONE no lleva atribución. Los DONE anteriores quedan a NULL («Sin atribuir»);
  sin backfill.
- **Marcar DONE** (`PATCH /treatment-plans/:id/items/:itemId` con
  `status: DONE`, el único camino que realiza un ítem; las reservas por cita
  no lo hacen): `performedById` opcional si quien marca atiende (DENTIST o
  ADMIN, se usa él); si no (ASSISTANT), 400 «Indica qué profesional realizó el
  procedimiento.». El profesional tiene que ser miembro VIVO de esta clínica
  (otra clínica o desactivado: 404), atender (ASSISTANT/RECEPTION: 400) y, si
  está restringido a sedes (DX-089), atender en la sede (400). La sede es la de
  `X-Location-Id` (o la de escritura de la sesión) y `completedAt` la hora del
  servidor (400 si llega). Todo en la transacción del ítem, con la membresía
  `FOR SHARE`. El registro del odontograma (`sourcePlanItemId`) lo firma quien
  lo realizó.
- **Corregir** quién o cuándo de un DONE: solo ADMIN (403 a los demás), fecha no
  futura; también en un plan cerrado (el trigger
  `treatment_plan_items_locked_when_closed` admite ese cambio y nada más). La
  sede no se corrige. Queda un `audit_event` en la misma transacción con
  `reason` PLAN_ITEM_ATTRIBUTION_CORRECTED y `metadata.attribution`
  (`before`/`after`: usuario, sede e instante; solo ids).
- **Salir de DONE** (a aceptado o propuesto): lo hacen ADMIN o quien lo realizó
  (un «marcado por error»; 403 a otro, para que nadie se lleve la producción
  ajena). La atribución se limpia y queda el evento PLAN_ITEM_DONE_REVERTED con
  el antes.
- **Respuesta**: cada ítem trae `performedById`, `performedByName`,
  `performedLocationId`, `performedLocationName` y `completedAt` (null = sin
  realizar o «Sin atribuir»).

## Visitas del plan: salida de «Completada» y reservas en otra cita (DX-256, DX-271, DX-273)

- **Intervalo mínimo** (DX-256): la visita N de un plan aceptado no se agenda
  antes de la última cita **COMPLETED** de la visita N−1 más su intervalo
  (`visitIntervals`), en días civiles de la sede del plan
  (`GET /treatment-plans/:id/visits` → `minimumDate`/`minimumDay`). Sin cita
  completada de la visita anterior (o con intervalo 0), el mínimo es hoy.
- **Salida de COMPLETED** (DX-273): pasar una cita completada a cualquier otro
  estado (agendada, confirmada, cancelada, no-show) solo lo hacen **ADMIN y
  DENTIST** (RECEPTION/ASSISTANT: 403 «Solo el odontólogo o la administración
  pueden sacar una cita de «Completada».»), y con `statusReason` en el
  `PATCH /appointments/:id` (3–500 caracteres tras recortar; sin él, 400).
  El rol se mira antes que el motivo: recepción recibe 403 aunque el motivo
  sea corto; fuera de una salida de COMPLETED el motivo se ignora.
  En la misma transacción:
  - el motivo se guarda en `appointment_status_reversals` (una fila por
    salida; la app solo tiene SELECT/INSERT; RLS FORCE por tenant; FK
    compuesta a la cita con borrado en cascada);
  - el mínimo de la visita siguiente de cada plan afectado **se recalcula de
    forma explícita**: con la última cita de la visita anterior que **siga**
    completada; si ya no queda ninguna, queda **sin mínimo** (se puede agendar
    desde hoy). No se conserva el mínimo anterior a propósito: si la cita se
    sacó de «Completada» es porque esa visita no se hizo (o no así), y su
    intervalo dejaría a la siguiente bloqueada sin motivo clínico. Por eso la
    salida queda restringida a quien responde de la clínica y con motivo;
  - la respuesta trae `completedExit: { reversalId, reason, visitMinimums }`
    con `minimumDayBefore`, `minimumDayAfter` (null = sin mínimo) y
    `anchorAppointmentIdAfter` por visita;
  - un `audit_event` (`APPOINTMENT`, `UPDATE`, `reason` `COMPLETED_EXIT`) con
    `status { from, to }`, `params.reversalId` y `visitMinimums` (plan,
    visita, día antes y después). El texto del motivo no va en la auditoría
    (solo admite códigos, DX-009): se llega a él por `reversalId`.
- **Tratamientos reservados en otra cita** (DX-273, revisión DX-271 I2): con
  DX-271 «Llegó» no choca si el tratamiento ya lo reserva otra cita viva; la
  reserva se queda allí. Ahora la respuesta del `PATCH /appointments/:id` (y
  de «Deshacer llegada», «Asignar» un hueco y «Traer a esta cita») y cada
  persona de `GET /appointments/in-clinic` traen `planItemsReservedElsewhere:
  [{ planItemId, name, toothNumber, heldInClinic, appointmentId, start,
  locationId, locationName, timeZone }]`: los tratamientos de la cita con
  vínculo vivo pero sin reserva que reserva otra cita viva (mismo predicado
  que el trigger `dx256_link_reservation`) y que siguen por hacer (ítem vivo y
  aceptado de un plan aceptado). Solo citas de sedes permitidas al usuario
  (DX-089): las demás se omiten sin dejar rastro. Vacío en una cita
  cancelada, no-show o completada.
  DX-293: `heldInClinic` es true si la cita que lo reserva es de hoy (día
  civil de su sede) con el paciente en la clínica, la misma regla
  (`heldInClinicToday`) que el 409 de «Traer a esta cita» (DX-288); la web
  entonces no ofrece «Traer» y explica dónde está la reserva. Una titular
  olvidada en la clínica de un día anterior o una cita futura: false. Si esa
  titular de hoy en la clínica es de una sede no permitida, sale igualmente
  pero con `appointmentId`, `start`, `locationId`, `locationName` y
  `timeZone` a `null` (sin cita, hora ni sede).
- **La reserva vuelve a la cita en la clínica** (revisión DX-273, I1): si la
  cita que reservaba un tratamiento deja de hacerlo (se cancela, se marca
  no-show o se le quita con `planItemIds`; no si se completa: se hizo allí),
  en la misma transacción la cita **más temprana** con el paciente en la
  clínica que lo tiene sin reserva la recupera (si nadie más lo reserva y el
  tratamiento sigue por hacer), con un `audit_event`
  `PLAN_ITEM_RESERVATION_RECOVERED` (`params`: `planItemId`,
  `fromAppointmentId`, `toAppointmentId`) en la sede de esa cita.
- **«Traer a esta cita»**: `POST /appointments/:id/plan-items/:planItemId/claim`
  (los cuatro roles de agenda). Solo con el paciente en la clínica
  (ARRIVED, IN_CHAIR, READY_FOR_CHECKOUT; si no, 409), con el tratamiento en
  la cita (si no, 404) y por hacer (aceptado, de un plan aceptado; si no, 409
  «Solo se agenda tratamiento aceptado y pendiente de un plan aceptado.»). En una transacción bloquea las dos citas en orden de
  id, retira el vínculo de la otra cita y reescribe el de esta (el trigger le
  da la reserva), con un `audit_event` `APPOINTMENT_PLAN_ITEMS` en cada cita,
  cada uno en la sede de su cita (`params`: `planItemId`,
  `fromAppointmentId`, `toAppointmentId`). Si la otra
  cita es de una sede no permitida, 403 sin decir cuál. Si ya nadie lo
  reserva (p. ej. se canceló la otra cita), solo recupera la reserva; si ya
  la tiene, no cambia nada. Si otra cita lo toma a la vez, 409 que dice cuál.
  DX-288: es atómico. Tras las citas bloquea la fila del ítem (`FOR NO KEY
  UPDATE`, que no estorba a las FK), así que dos «Traer» del mismo
  tratamiento desde citas distintas van en fila. Y no se trae desde una cita
  **de hoy** (día civil de la zona de su sede) con el paciente en la clínica:
  409 «Este tratamiento ya lo tiene otra cita con el paciente en la clínica,
  la de hoy a las 09:00 (Sede…). No se puede traer…», con la hora y la sede
  solo si esa sede está permitida al usuario (si no, el mismo texto sin
  datos, DX-089). Con N peticiones a la vez, una 200 y las demás 409, también
  si alguna llega cuando la primera ya confirmó. Una cita olvidada en la
  clínica de un día anterior no lo impide: se trae normalmente. El estado del
  tratamiento (por hacer) se comprueba con el ítem ya bloqueado. Desde la
  misma cita (doble clic) sigue siendo idempotente: todas 200 y un solo
  traslado auditado.

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

- **Zona de la sede**: la zona IANA de la propia sede (`locations."timeZone"`,
  G1), que se elige al crearla; ningún país la decide. Siempre de la BD, nunca
  del cliente. `GET /locations` la publica (`timeZone`) para que la web sepa
  qué día es «hoy» en la sede.
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

## Despliegue GLOBAL-G1 (fase 1)

Moneda, zona y formato pasan a ser de cada sede (`locations.currency`,
`"timeZone"`, `locale`; el país se pide siempre). El despliegue es **sin
parada**, en dos fases (expand/contract): esta es la fase 1; las columnas
siguen admitiendo NULL hasta la fase 2.

**Runbook (en este orden):**

1. `prisma migrate deploy` **con las réplicas antiguas sirviendo**. La
   migración solo añade columnas NULL, rellena las sedes existentes y añade
   restricciones que admiten NULL, así que el código anterior sigue
   funcionando. Las filas rellenadas quedan «por revisar» (aviso D5 al ADMIN).
2. Despliegue *rolling* de la API nueva. Después, la web nueva.
3. Cuando ya no quede ninguna réplica antigua:

   ```bash
   npm run g1:backfill-locations
   ```

   y la comprobación (las tres cifras tienen que ser 0):

   ```bash
   npm run g1:backfill-locations -- --check
   ```

   Imprime `locations_sin_configurar=N` (moneda, zona, formato o, desde G1-B,
   reloj NULL), `pendientes_legados_vigentes=N` y
   `pendientes_sin_reloj_vigentes=N` (G1-B, DX-350: registros vigentes de una
   web anterior a G1-B; la fase 2 solo pone NOT NULL a
   `pending_registrations."locationHourCycle"` cuando es 0) y sale con código
   1 si alguna no es 0. Corre con el rol de la app
   (`DATABASE_URL`), clínica por clínica bajo su RLS (también las retiradas),
   igual que escribe el barrido: no necesita las credenciales del owner, no
   hace DDL ni toma más bloqueo que el de un `SELECT`, así que se puede correr
   con tráfico. **No la sustituyas por un `SELECT count(*)` suelto como
   owner**: `locations` tiene FORCE RLS y el owner (sin superusuario ni
   BYPASSRLS) lee 0 filas sin clínica fijada, es decir, un falso 0. Si no da
   0: `npm run g1:backfill-locations` y repetir.

   Mientras tanto, el job `locations.regional-backfill` (programa
   `locations.regional-backfill.every-5-min`, cada 5 minutos; registra
   `locations.regional_backfilled` por clínica) barre las sedes que una
   réplica antigua haya creado sin esos valores. Es idempotente. Una sede en NULL se trata como «sin configurar» (error
   recuperable), nunca con un valor por país.

**Compatibilidad durante la convivencia:**

| Quién | Contra | Qué pasa |
|---|---|---|
| API antigua | BD de fase 1 | INSERT de sede sin columnas nuevas → filas NULL, las rellena el barrido (desde DX-312, el paso 0 del trigger rechaza ese INSERT); lee `location_schedules.timezone`, que el código nuevo mantiene igual a `Location.timeZone` (R20) |
| Web antigua | API nueva | `PUT /locations/schedule` con `timezone` igual a la zona de la sede se acepta; `LocationDto` solo gana campos. El registro sin campos de sede (forma legada) es 400 con `field: locationCountry` desde DX-312 |
| Web nueva | API antigua | `LocationDto` sin `currency` → `SedeConfigError`, nunca COP |
| Enlace de registro de una réplica antigua | API nueva | Con los campos de sede, `verify` lo acepta. Sin ellos (forma legada), 410 `REGISTRATION_LINK_EXPIRED` sin consumirlo, desde DX-312 |
| Web antigua | API antigua (`PUT /locations/schedule` con otra zona) | La zona se guarda solo en `location_schedules.timezone`, que el código nuevo no lee: se pierde. El ADMIN la corrige en Ajustes → Sedes |
| Registro pendiente con los cuatro campos (API nueva) | `verify` en una réplica antigua | Desde DX-312, el paso 0 del trigger de `locations` rechaza la sede sin datos regionales que crearía esa réplica: el alta se deshace entera, la respuesta es un 400 genérico, no se crea ninguna clínica y el pendiente queda consumido (ver «País de la sede ISO 3166 (DX-312)») |

La lista ISO de monedas amplía las aceptadas en listas, gastos, caja y planes;
el proveedor de tasas puede no tener alguna y esos abonos cuentan en
`unconvertedPaymentsCount`. La demo (`npm run seed:demo`) crea sus sedes con
`COP`, `America/Bogota`, `es-CO` y `CO` explícitos y ya revisadas.

### Fase 2 (ticket aparte)

«G1 · Fase 2: cerrar las columnas regionales de la sede» (DX-351, bajo
DX-311). Va en un release **posterior**, cuando no quede ninguna réplica
anterior a la fase 1. Precondición: `npm run g1:backfill-locations -- --check`
(ver arriba) da 0 en las dos cifras; si no, correr
`npm run g1:backfill-locations` y repetir. Cuenta, en todas las clínicas
(también las retiradas):

```sql
SELECT count(*) FROM locations
 WHERE currency IS NULL OR "timeZone" IS NULL OR locale IS NULL;
SELECT count(*) FROM pending_registrations
 WHERE "locationCurrency" IS NULL AND "expiresAt" > now();
```

Contenido del ticket:

- Migración (mismo bracket RLS que la de la fase 1): dentro del bracket NO
  FORCE, llamar antes a `SELECT dx_g1_backfill_location_regional();` (sin
  tenant: todas las clínicas) para que una fila que quede no la tumbe; luego
  `SET NOT NULL` en
  `locations.currency/"timeZone"/locale`;
  `ALTER TABLE location_schedules DROP COLUMN timezone`; borrar los pendientes
  legados caducados y poner NOT NULL en `locationCurrency`,
  `locationTimeZone`, `locationLocale` y `locationCountryCode` de
  `pending_registrations` (no en `locationCountry`, la columna legada);
  `DROP FUNCTION dx_g1_backfill_location_regional`.
- Código: borrar el job `locations.regional-backfill` y el script
  `g1:backfill-locations`; `PUT /locations/schedule` con `timezone` siempre
  400; quitar la doble escritura (R20); `LocationDto` sin `| null` (regenerar
  los tipos de la web); la web mantiene `SedeConfigError` solo para zona
  inválida.
- Tests: los de fase 1 (réplica antigua, NULL, barrido) pasan a comprobar el
  NOT NULL y la ausencia de defaults.
- **Ya hecho por DX-312** (no repetir): quitar el default del país de la sede
  (M4), borrar la rama legada de `verify` y exigir los cuatro campos de sede
  en el registro. **DX-351 no toca `locations."country"` ni
  `pending_registrations."locationCountry"`**: las borra la fase 2 de DX-312
  (ver «País de la sede ISO 3166 (DX-312)»).

## Cambiar la zona de una sede (G1, DX-313, DX-314)

`PATCH /locations/:id` (ADMIN, auditado) edita `currency`, `timeZone` y
`locale` de la sede; `null` en cualquiera es 400. Una sede con algún campo
regional sin configurar (NULL, réplica antigua sin barrer) se completa con los
tres (`currency`, `timeZone` y `locale`) en un mismo PATCH: un relleno parcial
es 400 con el primer campo que falta.

- **Orden de comprobaciones** al cambiar moneda o zona (valor distinto del
  actual), con la fila de la sede bloqueada (`SELECT … FOR UPDATE`) para que no
  se abra una caja entre la comprobación y la escritura:
  1. Con una caja `OPEN` en la sede: 409 `LOCATION_REGIONAL_CASH_OPEN`, aunque
     venga `confirmRegionalChange: true`.
  2. Con historial (citas, abonos, gastos y salidas de caja, inventario, cajas,
     listas de precios o versiones de política) y sin `confirmRegionalChange:
     true`: 409 `LOCATION_REGIONAL_CHANGE_UNCONFIRMED`.
- **No se convierte nada**: los importes guardados conservan su moneda. Cambiar
  la zona no reescribe ningún instante.
- **Efectos de cambiar la zona** (se documentan, no se corrigen): un abono
  guardado como mediodía civil (DX-097) puede cambiar de día si el desfase
  supera 12 h; los tramos de horario de la sede y de los profesionales se leen
  en la nueva zona; «hoy» de gastos, promesas, alertas e informes pasa a la
  nueva zona; las citas y los recordatorios conservan su instante.
- Rellenar un campo NULL (sede de una réplica anterior a G1 sin barrer) y
  cambiar el `locale` no piden confirmación ni comprueban la caja.
- Cualquier cambio de los tres campos, o `confirmRegionalSettings: true`, pone
  `regionalSettingsReviewedAt = now()`.
- Cambiar la zona actualiza en la misma transacción
  `location_schedules.timezone` (columna legada de la fase 1, R20).
- Auditoría: `metadata.regionalSettings = { before, after, reviewed }`.

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

## Compromiso de pago que se reabre al anular su abono (DX-215)

Un compromiso de pago (DX-150) pasa a `KEPT` cuando los abonos lo cubren. Si
después se anula (`DELETE /api/v1/payments/:id`, solo ADMIN/RECEPTION con la
regla de SEC-013) un abono que contaba para él, ya no es verdad que se pagó:

- **En la misma transacción que la anulación** se vuelve a evaluar cada
  compromiso `KEPT` del paciente en la moneda del abono para el que ese abono
  contaba (misma moneda, registrado desde el compromiso y fechado hasta su
  día), del más reciente al más antiguo: normalmente el último, pero también
  uno anterior que ese abono cumplió aunque después se cumpliera otro. Con los
  abonos que siguen vivos: si aún lo cubren, sigue `KEPT`; si no,
  vuelve a `OPEN` mientras no haya pasado su día en la zona de su sede, o pasa
  a `BROKEN` desde el día siguiente (`statusAfterVoid` en
  `payment-promise-rule.ts`, con el reloj de la anulación). Si el paciente ya
  tiene otro compromiso `OPEN` (uno solo por paciente, o uno más reciente que
  se acaba de reabrir), queda `BROKEN`: el vigente es el nuevo.
- **Auditoría**: un `UPDATE` de `PAYMENT_PROMISE` con quien anula, su sede y su
  petición, `reason: PAYMENT_VOIDED`, `params.paymentId` y `statusChange`
  (`from: KEPT`, `to: OPEN | BROKEN`). Ni importes ni el texto de las notas.
  Se escribe en la misma transacción que el cambio (o ninguno de los dos).
- **`reopenedAt`** (compromiso en la ficha y en la cartera): la última vez que se
  reabrió, puesta por el servidor de BD en UTC. La web lo enseña como
  «Reabierto: se anuló el abono que lo cumplía».
- **La BD solo lo admite por esta vía**: el trigger append-only de
  `payment_promises` acepta `KEPT → OPEN | BROKEN` únicamente si la MISMA
  transacción anuló un abono del paciente, en esa moneda y registrado desde el
  compromiso (la versión viva de la fila es de esa transacción). Ninguna otra
  columna cambia, `BROKEN` no se reabre y nada se borra.
- **Concurrencia**: crear un compromiso, cerrarlo (abono o barrido) y reabrirlo
  toman el mismo candado consultivo por paciente
  (`payment_promise:<tenant>:<paciente>`, hasta el fin de la transacción) y
  releen compromiso y abonos después de obtenerlo; las transiciones son
  condicionales (`WHERE status = …`). Una anulación y un barrido simultáneos
  no dejan un compromiso cumplido con un abono anulado ni duplican
  transiciones o eventos (`test/payment-promise-reopen.int-spec.ts`).
- Los compromisos que quedaron `KEPT` con un abono anulado ANTES de esta
  versión no se tocan (migración solo aditiva).

## Tope de descuento por rol e informe de descuentos (DX-204)

- **Política** (`discount_policies`, una fila por clínica, RLS FORCE): % máximo
  de descuento por ítem según el rol de quien lo da y el % por encima del cual
  el motivo es obligatorio. Sin fila, los valores por defecto: ADMIN 100,
  DENTIST 10, ASSISTANT y RECEPTION 0; motivo por encima del 10 %.
  `GET /api/v1/discount-policy` (ADMIN, DENTIST, ASSISTANT) y
  `PUT /api/v1/discount-policy` (solo ADMIN, auditado como `DISCOUNT_POLICY`).
- **En el servidor**: al crear o editar un ítem del plan (y en
  `POST /treatment-plans/:id/items/bulk-discount`) el descuento se compara en
  céntimos con el tope del rol del token: si lo supera, 403 «Tu rol permite
  hasta un X % de descuento por ítem.» y no se escribe nada. Por encima del
  umbral sin `discountReason` (o con `OTHER` sin nota), 422. Cambiar el precio
  de un ítem con descuento vuelve a comprobar su %. Quitar un descuento (0) lo
  puede cualquier rol que edite el plan. Cada descuento guarda
  `discountById`, `discountAt` (hora del servidor) y `discountLocationId` (la
  sede del request o la principal).
- **«Descuento %» en bloque**: el % de cada precio, redondeado a la unidad de la
  moneda del plan (COP, CLP, JPY, KRW y PYG sin decimales; el resto a
  céntimos) y nunca por encima del tope del rol ítem a ítem (si el redondeo lo
  pasara, baja a la unidad que lo respeta). Todo o nada, en una transacción;
  un evento de auditoría (`reason` BULK_DISCOUNT) sin importes ni la nota.
- **Plan aceptado** (con o sin firma) o cerrado: sus descuentos no cambian (409).
  Los triggers de bloqueo de ítems cubren también las columnas del descuento.
- **Informe** `GET /api/v1/reports/discounts` y `.csv` (solo ADMIN, auditados
  como VIEW/EXPORT de `TREATMENT_PLAN_ITEM` con `reason` DISCOUNT_REPORT):
  ítems vivos con descuento > 0 de planes vivos y no anulados (ni rechazados
  ni cancelados: una alternativa DX-040 copia los descuentos y la opción
  rechazada los duplicaría), por días civiles de la zona de
  su sede (`from`/`to`, como mucho 366 días), sede (`locationId` o
  `X-Location-Id`) y quién lo dio (`professionalId`). Totales por moneda (bruto
  = precio de esos ítems, % sobre el bruto) y detalle paginado. Los descuentos
  anteriores a DX-204 se fechan por el alta del ítem, con la sede de
  presentación del plan y sin autor. El CSV protege las celdas contra fórmulas
  como el de la cartera.
- **Precio por debajo del de catálogo = descuento (SEC-041)**. Cada ítem guarda
  `catalogPrice`: el `defaultPrice` del catálogo al darlo de alta (NULL en un
  ítem libre, cuyo catálogo no tiene precio; la migración
  `20261019194000_sec041_plan_item_catalog_price` rellenó los existentes con el
  precio de catálogo ACTUAL). El descuento que se compara con el tope del rol y
  con el umbral del motivo es el **efectivo**: `max(0, catalogPrice − price) +
  discount`, en % del precio de referencia (el de catálogo si el precio está
  por debajo). En el alta, la edición y el bloque. 403 «Precio por debajo del
  de catálogo: cuenta como descuento. Tu rol permite hasta un X %…»; 422 «…
  Indica el motivo del descuento.». La rebaja se firma con las columnas del
  descuento (quién, cuándo, sede, motivo). Subir el precio es libre (no
  re-firma; si el ítem vuelve a no tener descuento efectivo, se borra la
  firma); quitar el `discount` de un ítem cuyo precio sigue rebajado también,
  y conserva la firma de la rebaja. En un plan aceptado el precio no baja (409).
  El informe y su CSV muestran precio de catálogo, rebaja de precio, descuento
  del ítem y el total (bruto = precio de referencia); el índice parcial pasa a
  `treatment_plan_items_tenant_effective_discount_at_idx`.
- **Rebaja de convenio en el informe (SEC-047)**. El informe y su CSV
  incluyen también los ítems resueltos por convenio con rebaja (`basePrice` >
  `catalogPrice`), aunque no tengan descuento propio, con `agreementName`,
  `basePrice`, `agreementReduction` (max(0, `basePrice` − `catalogPrice`)) y
  su %, quién asignó el convenio (`agreementAssignedById`/`Name`: el autor de
  la asignación de ese convenio al paciente más reciente no posterior al alta
  del ítem) y quién creó el ítem (`createdById`/`Name`, columna nueva de
  `treatment_plan_items`, NULL en los ítems anteriores). La rebaja de convenio
  va APARTE: los totales de DX-204 (`totals`: ítems, bruto, descuento y %) se
  agregan con `FILTER` solo sobre las líneas que cuentan como descuento y no
  cambian al entrar una línea solo de convenio; las rebajas van en
  `agreementTotals` (líneas y suma por moneda) y `total` (paginación) cuenta
  todas las líneas. Con `professionalId`, una línea cuenta como descuento si
  esa persona lo dio (como en DX-204) y como rebaja si creó el ítem, asignó
  el convenio o dio su descuento. Una línea solo de convenio de un plan sin
  presentar toma la sede con la que se resolvió el precio
  (`pricingLocationId`). En el CSV, su motivo es «Convenio …» y «Dado por» es
  quien asignó el convenio (o, sin él, quien creó el ítem). Migraciones `20261024120000_sec047_plan_item_created_by` y
  `20261024120100_sec047_plan_item_agreement_reduction_idx` (parcial
  `treatment_plan_items_tenant_agreement_reduction_at_idx`, CONCURRENTLY).
  e2e: `test/discounts-agreement.e2e-spec.ts`.
- **Estado del plan en la transacción (BE-036)**: alta, edición y bloque
  bloquean la fila del plan (FOR SHARE; el ítem, FOR UPDATE), la releen y solo
  entonces validan si está aceptado, firmado o cerrado. Una aceptación sin
  firma que confirma mientras una edición espera ya no deja cambiar el plan
  aceptado (`test/plan-item-accept-race.int-spec.ts`).

## Reportes: «Comparar sedes» (DX-014)

Módulo `src/modules/reports`. `GET /api/v1/reports/locations-comparison` y
`GET /api/v1/reports/locations-comparison.csv` (solo ADMIN; DENTIST,
RECEPTION y ASSISTANT → 403 «Solo la administración ve los reportes de la
clínica.»), con `from`/`to` (días civiles `AAAA-MM-DD`, ambos inclusive, como
mucho 366 días; las dos fechas entre 2000-01-01 y 2100-12-31, DX-305), `compare` (`previous` por defecto: los mismos días
inmediatamente antes; `previous_year`: las mismas fechas un año antes, el
29/02 cae en el 28; `none`) y `currency` opcional (solo los importes en esa
moneda). Errores 400 en español.

- **Una fila por sede** viva (activa o desactivada) que ve quien consulta,
  en orden de creación, y «Total clínica». Respeta el claim `loc` (DX-089):
  con sedes acotadas solo salen esas y el total solo las suma a ellas (hoy un
  ADMIN nunca lleva `loc`, pero el reporte no depende de eso). La cabecera
  `X-Location-Id` se valida como siempre pero **no acota** la comparación.
  Las sedes retiradas no salen (ni cuentan en el total).
- **Indicadores**: una sola definición en
  `src/modules/reports/domain/kpi-definitions.ts` (etiqueta, unidad, si es por
  moneda, dirección «mejor» y el texto de «Cómo se calcula»), que la respuesta
  publica en `kpis`. Producción = Σ (precio − descuento) de los ítems DONE con
  `completedAt` (DX-050) en el período, por `performedLocationId` y moneda del
  plan («Sin atribuir» no cuenta); cobrado = Σ abonos no anulados por `paidAt`,
  sede y moneda; % de cobro = cobrado ÷ producción (null sin producción);
  citas atendidas = COMPLETED por inicio; no-show % = NO_SHOW ÷ (COMPLETED +
  NO_SHOW + canceladas con `lateCancellation`, DX-279; las avisadas a tiempo
  no cuentan); pacientes nuevos =
  primera COMPLETED del paciente en la clínica, en la sede de esa cita; ticket
  medio = cobrado ÷ pacientes distintos atendidos (en el total, cada paciente
  una vez); ocupación % (DX-305, BE-042) = minutos COMPLETED de los
  profesionales con horario en la sede ÷ **capacidad**: Σ, profesional a
  profesional, de los minutos de su horario semanal VIGENTE en la sede
  (DX-233, con sus excepciones por fecha), menos sus bloqueos que no admiten
  citas (de esa sede o de todas, DX-122) y los cierres de toda la sede; con
  tope de 100 %. Dos profesionales en paralelo son el doble de capacidad; uno
  de media jornada, la mitad. Sin profesionales con horario en la sede,
  ocupación null (y fuera de la del total). Días civiles en la zona de cada
  sede (DX-097).
- **Período comparado sin producción atribuida** (DX-305, BE-045): si
  empieza (a medianoche de la zona de la sede) antes de que la base registrara
  la atribución de DX-050 y la clínica tiene realizados vivos «Sin atribuir»,
  o si tuvo cobros en una moneda sin producción, producción y % de cobro de
  esas monedas salen con `change`/`trend` null y `previousUnattributed: true`;
  la fila lleva `previousPeriodUnattributed` (y la respuesta, si alguna fila
  la lleva). El instante de DX-050 lo da `dx_production_attributed_since()`:
  la migración `20261024151000_dx305_production_attributed_since` copió en su
  cuerpo el `finished_at` de la migración de DX-050 de esa base (la app no lee
  `_prisma_migrations`). El CSV lo dice en la columna «Aviso».
- **Rango de fechas** (DX-305, BE-044): `checkPeriodDays` en
  `src/shared/time/civil-day.ts` es la única validación de los días de un
  período (existen, orden y 2000-01-01…2100-12-31); la usan este reporte, el
  de descuentos y la caja (`GET /payments`), con 400 en español.
- **Monedas**: nunca se suman ni se convierten. Cada importe es una lista por
  moneda; en una fila, todas las monedas que tuvo (en el período o en el
  comparado) salen en los cuatro indicadores de dinero. La conversión con tasa
  queda para otra porción.
- **Comparación**: cada valor trae `previous`, `change` (1 decimal, en la
  unidad `changeUnit` de su KPI: % relativo, (valor − anterior) ÷ |anterior|,
  null con anterior 0; o **puntos porcentuales** en % de cobro, no-show % y
  ocupación %, valor − anterior: 8 % → 10 % = +2 p.p.) y `trend`
  (`BETTER`/`WORSE`/`EQUAL` según la dirección: el no-show mejora al bajar).
- **CSV**: mismos filtros; formato largo (una línea por sede, indicador y
  moneda, el total al final), UTF-8 con BOM, CRLF, celdas de texto protegidas
  contra fórmulas como el de descuentos, `Cache-Control: no-store`.
- **Sin auditoría**, como el dashboard: son sumas por sede, sin datos de
  ningún paciente.
- **Consultas**: por período, una consulta agregada por fuente (nunca una por
  sede), con el tenant explícito además de la RLS, en una transacción
  REPEATABLE READ; los dos períodos en paralelo. Índice nuevo
  `treatment_plan_items_tenant_done_completed_idx` (parcial, CONCURRENTLY,
  migración `20261024130000_dx014_plan_items_done_completed_idx`) para la
  producción. Benchmark con 5 sedes y 24 meses: medianas de 170 ms (un mes) a
  ~470–650 ms (12 meses frente a los 12 anteriores) con la máquina cargada
  (`docs/perf/DX-014.md`).
- **Demo**: además del calendario, un día con actividad en cada sede en el
  mes anterior y en el actual (citas atendidas, procedimiento realizado allí y
  su abono), para ver la comparación cualquier día del mes
  (`planComparisonHistory`). Si hoy es el primer día abierto del mes, el mes
  actual solo tiene lo de hoy.

## Recibo de caja por abono (DX-136)

Cada abono nuevo nace con su **recibo de caja numerado por sede** (`NOR-000123`),
en la MISMA transacción que el abono (`issuePaymentReceipt`):

- **Serie de la sede**: `locations."receiptPrefix"` (2–6 caracteres, única por
  clínica, también entre sedes retiradas). Si no viene al crear la sede, el
  trigger `locations_default_receipt_prefix` la deriva del nombre: 3 letras sin
  tildes ni palabras genéricas ("Sede Norte" → `NOR`, "Sede principal" → `PRI`)
  y, si ya la usa otra sede de la clínica, con un número detrás (`NOR2`). La
  migración la rellenó en las sedes existentes. DX-019 dará la pantalla para
  cambiarla. Las altas simultáneas de sedes de la misma clínica no chocan
  (DX-216): el trigger toma un candado consultivo de transacción por clínica
  (`pg_advisory_xact_lock(hashtext('dx_location_receipt_prefix'),
  hashtext(tenantId))`) y la segunda alta, al seguir, ya ve la serie de la
  primera y toma la siguiente. Otras clínicas no esperan. Vale en READ
  COMMITTED (como crea sedes la API); en una transacción REPEATABLE READ que ya
  leyó antes, el índice único sigue rechazando el duplicado.
- **Serie inmutable una vez usada** (DX-226): es la numeración legal del
  recibo. El trigger `locations_receipt_prefix_guard` (`BEFORE UPDATE OF
  "receiptPrefix"`) rechaza con `check_violation` cambiar (o quitar) la serie
  de una sede que tiene recibos o el contador de su serie, también al
  superusuario; una sede sin recibos sí puede cambiarla. Ninguna sede (alta o
  cambio) puede tomar una serie que ya numeró recibos o tiene contador en la
  clínica, aunque la sede que la usó ya no la tenga, y la serie derivada de
  una sede nueva salta esas series. Se comprueba contra los recibos y
  contadores (inmutables), con la RLS de quien escribe y bajo el mismo
  candado por clínica. Emitir un recibo retiene la fila de la sede (`FOR KEY
  SHARE`) hasta el COMMIT, así que un cambio de serie simultáneo espera y se
  rechaza al ver el recibo. La API no expone hoy el cambio de serie (lo dará
  DX-019, que tendrá que traducir el `check_violation` a un 409 en español).
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

## Caja por turno (DX-027)

Apertura y cierre de la caja de **un usuario en una sede** con arqueo por
moneda y método, módulo `src/modules/cash-sessions`, tablas `cash_sessions`,
`cash_session_floats`, `cash_session_closings`, `cash_session_closing_lines`,
`cash_session_adjustments` y `cash_session_reopenings` (migración
`20261018140200_dx027_cash_sessions`).

- **Una caja abierta por (sede, usuario)**: índice único parcial
  `cash_sessions_open_key`; abrir otra es 409. `POST /cash-sessions/open`
  (sede del cuerpo, de `X-Location-Id` o la principal) con el **fondo
  inicial por moneda** (≥ 0, en efectivo) y notas. `GET /cash-sessions/current`
  devuelve la caja abierta de quien consulta en la sede y los ajustes de caja.
- **Abonos**: cada abono nuevo entra en la caja abierta de quien lo registra
  en su sede (`payments."cashSessionId"`, en la misma transacción y con la caja
  bloqueada `FOR SHARE`). Sin caja abierta, como antes (sin caja), salvo que la
  clínica active «exigir caja abierta»: entonces un abono en **efectivo** es
  409 en español; los demás métodos siguen igual.
- **Cierre** `POST /cash-sessions/:id/close` con lo contado por moneda y
  método: con la caja bloqueada `FOR UPDATE` calcula el **esperado** = fondo
  (efectivo) + abonos activos del turno + ajustes que entraron en ella (un abono
  sin método cuenta como «Otro») y guarda esperado, contado y diferencia
  (CHECK `difference = counted - expected`). Una diferencia distinta de 0 exige
  `differenceReason` (400). Deja `suggestedLockDate` (día civil del cierre en la
  sede) para DX-091, sin bloquear nada todavía. **Inalterable** por trigger:
  la apertura, el fondo, el cierre y sus líneas no se editan ni se borran, y un
  abono solo entra en una caja ABIERTA de su sede y nunca cambia de caja.
- **Arqueo ciego** (ajuste de la clínica): con la caja abierta, quien no es
  ADMIN recibe `expected` y `payments` a `null` en `GET /cash-sessions/:id` y
  cuenta antes de ver el teórico. El 400 por diferencia no dice cuánto.
  `GET /payments` (la caja del período, DX-002) sigue mostrando los abonos.
- **Lo que llega tarde no toca una caja cerrada**: anular uno de sus abonos o
  registrar un abono con fecha de un día ya cerrado en la sede crea un
  **ajuste** (`VOID` en negativo, `LATE_PAYMENT` en positivo) en la caja
  abierta de quien lo hace en esa sede, con enlace a la cerrada
  (`originalSessionId`). Sin caja abierta, queda pendiente y se une (una vez)
  a la siguiente caja que se abra en la sede. Un abono anulado con su caja aún
  abierta deja de contar y sale en «Anulados».
- **Reabrir** (`POST /cash-sessions/:id/reopen`, solo ADMIN, con motivo): el
  cierre anterior se conserva; el siguiente es la vuelta 2. 409 si quien la
  abrió ya tiene otra caja abierta en la sede. **Corregir** un cierre (`POST
  /cash-sessions/:id/adjustments`, solo ADMIN): un ajuste `CORRECTION` con
  motivo y autor, que cuenta en la caja abierta del ADMIN en la sede (o en la
  siguiente).
- **Roles**: ADMIN y RECEPTION (403 en español al resto). ADMIN ve y cierra
  todas; RECEPTION solo ve, abre y cierra las suyas (404 en las ajenas).
  `GET /cash-sessions` filtra por `locationId`, `from`/`to` (días de apertura
  en la zona de cada sede), `status` y página.
- **Ajustes de caja** de la clínica (`tenants."cashRequireOpenSession"` y
  `"cashBlindClose"`, por defecto `false` = el comportamiento de antes):
  `GET /cash-sessions/settings` (ADMIN y RECEPTION) y `PUT` (solo ADMIN).
- **Auditoría**: recurso `CASH_SESSION` (abrir `CREATE`, cerrar/reabrir/ajustes
  `UPDATE` con `metadata.reason`, correcciones `CREATE`, consultas `VIEW`).
  Motivos y notas no van a la auditoría ni a los logs.
- **Informe de cierre**: la web imprime la vista A4 (`/print/cash-sessions/:id`)
  y el navegador la guarda como PDF (la API no genera PDF). El envío por email
  al ADMIN queda fuera de esta entrega.

## Códigos clínicos: CIE-10 (DX-212)

Diagnósticos CIE-10 (estándar internacional) en la evolución y código de
habilitación REPS de la sede. DX-318 y DX-320 (epic DX-311, producto global)
retiraron el indicador «listo para RDA» (`GET /clinical-entries/:id/rda-readiness`
y su variante por lotes `GET /patients/:id/clinical-entries/rda-readiness`,
ahora 404 y fuera del contrato OpenAPI) y el código CUPS del catálogo
(columna `dental_catalog_items.cupsCode` borrada en
`20261024173000_dx320_drop_catalog_cups_code`). El catálogo se identifica solo
por su código interno: no hay «código externo del procedimiento» (decisión
D4). Un cliente antiguo que aún mande `cupsCode` en `POST`/`PATCH
/catalog/items` ve el campo descartado por la `ValidationPipe` global
(`whitelist`), como cualquier campo desconocido.

- **CIE-10** (`icd10_codes`): tabla de referencia global, sin tenant ni RLS
  (como `currencies`/`cities`), con las subcategorías de 4 caracteres del
  capítulo oral (K00–K14) y Z01.2. La siembra `prisma db seed` (upsert por
  código, idempotente, nunca borra). `GET /reference/icd10?q=` (cualquier
  sesión) busca por código con o sin punto («K02», «k021») o por texto sin
  tildes («caries»), con la columna generada `search_text`
  (`dx_search_normalize`) y su índice trigram; como mucho 20, primero los que
  empiezan por lo buscado.
- **Diagnósticos de la evolución** (`clinical_entry_diagnoses`): `diagnoses`
  en `POST /patients/:id/clinical-entries`, 1 `PRINCIPAL` y hasta 3
  `RELACIONADO` con diente FDI opcional. Se insertan en la MISMA transacción
  que la evolución (trigger `dx_clinical_entry_diagnosis_with_entry`: su
  `createdAt` tiene que ser el de la transacción) y son inalterables como ella
  (`dx_forbid_clinical_record_mutation`, `search_path` fijo — SEC-032). Un
  segundo principal, más de 3 relacionados, un diente no FDI o un código que no
  está en la tabla dan 400 en español («Código CIE-10 no válido: «K99.9»»).
  Sin diagnóstico la evolución se sigue guardando. Una corrección es una adenda
  en la evolución y una evolución nueva con el diagnóstico. RLS FORCE, FK
  compuesta a la evolución (misma clínica y paciente) y RESTRICT al código.
- El código REPS de la sede se borró en DX-319 (ver «Nº de registro
  sanitario de la sede»).
- **Sede de la evolución** (DX-232, `clinical_entries."locationId"`): la de la
  cita ligada o, sin cita, la sede activa de la petición (`X-Location-Id`; sin
  ella, la principal). FK compuesta: siempre una sede de la misma clínica.
- **Demo**: diagnósticos en tres evoluciones.

## Nº de registro sanitario de la sede (DX-319)

Sustituye al código REPS de la sede (DX-212), que solo servía en Colombia
(DX-311: Dentalix es global, ninguna regla depende del país).

- **`locations.healthRegistrationNumber`**: texto libre opcional, sin formato
  ni validación por país, hasta 64 caracteres (CHECK
  `locations_health_registration_number_check`: 1–64 y sin espacios a los
  lados). `PATCH /locations/:id` (solo ADMIN; el resto 403, otra clínica 404)
  lo recorta; vacío o `null` lo quita y sin el campo no cambia. Va en la
  respuesta de la sede (`GET /locations`).
- **`locations.showHealthRegistrationNumber`** (por defecto `false`): si el nº
  sale en los documentos de la sede. Hoy ningún documento imprimía el REPS, así
  que ninguno lo imprime aún; DX-306 (justificantes) lo usará como campo
  opcional, solo con el booleano activo.
- **Auditoría**: el `UPDATE` de `LOCATION` lleva, además de los campos
  cambiados, `metadata.healthRegistration` con el nº y el booleano antes y
  después (solo si cambió alguno). Es la única excepción de texto en la
  metadata: un dato público de la sede, nunca de un paciente; el saneado admite
  1–64 caracteres sin caracteres de control. El handler lo deja en
  `req.auditMetadata`, que el interceptor sanea y no deja pisar sus campos.
- **`repsHabilitationCode` en el cuerpo → 400** («El código REPS ya no
  existe…»): la ValidationPipe global solo descartaría el campo y una web
  antigua mostraría «Guardado» sin guardar nada.
- **Migraciones**: `20261024174000_dx319_location_health_registration` añade
  las dos columnas (compatible hacia atrás) y
  `20261024174100_dx319_drop_location_reps` **copia el REPS existente** al nº
  de registro sanitario (en Colombia es el registro de la sede; así el ADMIN
  no lo pierde) solo donde no hay nº y sin activar la impresión, y luego hace
  `DROP COLUMN IF EXISTS` (solo lo referenciaba su CHECK; ni vistas, ni
  funciones, ni índices, ni RLS). Con FORCE quitado durante la copia (owner
  sin BYPASSRLS) e idempotente. El nº nuevo no admite saltos de línea ni
  caracteres de control o de formato (DTO con `\p{Cc}\p{Cf}`, el mismo saneado
  en la auditoría y CHECK con `[[:cntrl:]]`); `showHealthRegistrationNumber:
  null` da 400.
- **Runbook de despliegue (DX-319)**: el `DROP COLUMN` va en el MISMO
  despliegue que el código que deja de leer la columna. Una instancia con el
  código anterior que siga viva después de `migrate deploy` da 500 al leer
  sedes (Prisma selecciona `repsHabilitationCode`). Con más de una instancia,
  este despliegue exige **parada única** (parar todas, `migrate deploy`,
  arrancar el código nuevo) o **desplegar primero el código nuevo** en todas
  las instancias (no lee la columna y funciona con ella o sin ella) y solo
  entonces correr `migrate deploy` y retirar las viejas. Nunca `migrate deploy`
  con instancias del código anterior sirviendo tráfico.

## Registro de implantes (DX-191)

Ficha de cada implante, pilar, injerto o membrana colocado (Res. 4816/2008
art. 31 en CO; Reglamento (UE) 2017/745 art. 18 y RD 192/2023 art. 36 en ES),
módulo `src/modules/implants`, tabla `patient_implants`.

- **Alta** `POST /patients/:id/implants` (DENTIST y ADMIN; el resto 403 en
  español): diente FDI (el mismo validador que el odontograma, con
  temporales), tipo `IMPLANT|ABUTMENT|GRAFT|MEMBRANE|OTHER`, fabricante,
  sistema, referencia (REF), lote, UDI, diámetro × longitud, registro
  sanitario (texto libre), notas, fecha de colocación (por defecto hoy en la
  sede, nunca futura) e ítem del plan opcional (de un plan del mismo
  paciente). Falta de fabricante, REF o lote o diente inválido: 400 con todos
  los errores en un mensaje. Profesional del token y sede del request (o la
  principal).
- **Inalterable**: sin PATCH/PUT/DELETE. Se corrige anulando con motivo
  (`POST /implants/:id/void`, autor o ADMIN; 409 la segunda vez) y
  registrando otro. Trigger `dx_patient_implants_immutable` (`search_path`
  fijo): solo deja anular una vez y marcar la entrega de la tarjeta una vez;
  DELETE/TRUNCATE solo un superusuario. RLS FORCE y FK compuestas por tenant a
  paciente, sede e ítem del plan.
- **Retención (DX-039)**: insertar un implante adelanta
  `patients.last_attention_at` (mediodía UTC del día de colocación, con tope
  en hoy), así que el bloqueo de archivo y borrado de la HC cuenta con él.
- **Tarjeta de implante** (los 4 roles: recepción la entrega):
  `GET /patients/:id/implant-card?date=YYYY-MM-DD` compone la intervención del
  día (identidad y documento del paciente, clínica y sede, profesional(es) y
  cada componente; los anulados marcados; sin notas, motivo ni diagnóstico).
  `POST /patients/:id/implant-card/print` registra la fecha de entrega en los
  implantes vivos del día (la primera; reimprimir no la mueve) y deja `PRINT`
  en la auditoría. La API no genera PDF (no hay librería de PDF): la web
  imprime la vista A4/carta y el navegador guarda como PDF.
- **Búsqueda por lote/REF** (solo ADMIN): `GET /implants/search?lot=&reference=`
  y `GET /implants/search.csv` (UTF-8 con BOM, anti fórmulas), coincidencia
  exacta sin mayúsculas ni blancos alrededor (también en el parámetro) sobre
  las columnas generadas `lotKey`/`referenceKey` (`upper(btrim(...))`) y sus
  índices `patient_implants_tenant_lot_key_idx`/`_reference_key_idx`, que
  sirven bajo RLS porque la consulta compara la columna con `=` (DX-225), SIEMPRE en toda la
  clínica (la sede activa no la acota: una retirada de lote no puede dejar
  fuera a un paciente operado en otra sede; la columna «Sede» lo dice). Cada consulta deja `VIEW`/`EXPORT` sobre `PATIENT_IMPLANT`
  con `metadata.search = { lot, reference, rows }` (el nº de filas sale de la
  cabecera `X-Result-Count`); nada en los logs.
- **Autocompletar**: `GET /implants/catalog` (DENTIST y ADMIN), fabricantes y
  sistemas ya usados por la clínica.
- **Demo**: implante y pilar del 36 del paciente del plan de implante y otro
  paciente con el mismo lote `DEMO-LOT-2026A`.

## Personal restringido a sedes (DX-089)

Un miembro puede atender solo en algunas sedes de la clínica (la recepción de
la Sede Norte, por ejemplo). Por defecto nadie está restringido.

- **Tabla `membership_locations`** (RLS FORCE, FK compuesta a la membresía y a
  la sede): una fila por sede permitida. **Sin filas = todas las sedes**, que es
  como quedan todos los miembros existentes. Las sedes inactivas o borradas no
  cuentan; si a un restringido no le queda ninguna activa, no ve ninguna (nunca
  se amplía a «todas»).
- **Claim `loc` del JWT**: login, refresh, cambio de contraseña y aceptar una
  invitación ponen en el access token `loc: [ids]` con las sedes activas
  permitidas (en el orden de creación de las sedes). Sin `loc` = todas; el ADMIN
  y el break-glass nunca lo llevan. Un cambio de sedes **surte efecto en el
  siguiente refresh** del token (como un cambio de rol), no al instante.
- **403 con `code`**: una cabecera `X-Location-Id` o una sede explícita
  (`?locationId=`, `locationId` del body, una cita, caja, ítem… de otra sede)
  que el miembro no tiene da
  `403 { code: "LOCATION_NOT_ALLOWED", message: "No tienes acceso a esta sede." }`.
  Una cabecera con una sede que no es de la clínica sigue dando el 400 de
  siempre (se valida antes). Sin ninguna sede activa al escribir: mismo `code`, «No tienes ninguna
  sede activa asignada.».
- **Sin cabecera de sede**: los listados son el consolidado de SUS sedes (no de
  toda la clínica) y las escrituras van a la primera sede permitida y activa
  (no a la principal). Con una sola sede permitida, la API la fija como si
  hubiera mandado la cabecera (auto-pin). Sin restricción, todo sigue igual.
- **Módulos afectados**: agenda (citas, huecos libres, pendientes por agendar,
  bloqueos y horario de la sede), caja (abonos y turnos de caja), inventario,
  recetas (sede emisora), cartera, cobranza, presupuestos por seguir,
  `GET /locations` (solo sus sedes) y la sede que se sella en presupuestos,
  descuentos e implantes. Las filas sin sede (planes antiguos, ledgers sin
  sede) no las ve un restringido.
- **No afectados** (son de toda la clínica): pacientes, historia clínica
  (evoluciones, odontograma, periodontograma, consentimientos), catálogo, los
  listados por paciente (su agenda, estado de cuenta…) y los módulos solo-ADMIN
  (el ADMIN siempre tiene todas las sedes).
- **Endpoints** (solo ADMIN, `@Roles(...STAFF_WRITE_ROLES)`):
  `GET /staff/:userId/locations` → `{ all, locationIds }` y
  `PUT /staff/:userId/locations` con `{ locationIds: [...] }` (`[]` = todas;
  máx. 50, uuids). Reemplaza el conjunto entero en una transacción, queda en
  `audit_events` (`UPDATE`, `STAFF_MEMBER`, `LOCATIONS_CHANGED`) y una sede
  ajena, inactiva o borrada da 400 «Alguna sede no existe en esta clínica.» sin
  escribir nada. `GET /staff` y la ficha del miembro traen `locationIds`
  (`null` = todas). Otra clínica: 404.
- **Invariante del ADMIN**: no se puede restringir (`PUT` → 409 «El ADMIN
  siempre tiene todas las sedes y no se puede restringir.»). Ascender a ADMIN
  (`PATCH /staff/:userId`) borra sus filas en la misma transacción, y también
  reinvitar como ADMIN a un miembro retirado. Retirar a un miembro conserva sus
  filas: si se le reinvita con otro rol, vuelve restringido a las mismas sedes.
- **Profesional ↔ sede**: un odontólogo restringido solo atiende en sus sedes.
  Agendar o mover una cita a un profesional en una sede donde no atiende,
  pedir sus huecos libres allí o filtrar la agenda por él en esa sede da
  400 «Algún profesional no atiende en esta sede.». Al editar una cita cuenta la
  sede de la propia cita.
- **Bloqueos «todas las sedes»**: crearlos, editarlos, borrarlos o ver sus
  citas afectadas exige no estar restringido (403 si no); un restringido
  bloquea indicando una de sus sedes. Sí ve los de «todas las sedes» en su
  agenda.
- **Demo**: «Recepción Norte» (`recepcion.norte@demo.dentalix.app`, RECEPTION)
  solo atiende en la Sede Norte; la recepción de siempre
  (`recepcion@demo.dentalix.app`) sigue con todas.

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

  **Sondas (DX-220).** El proceso `worker` no tiene HTTP de negocio. Con
  `JOBS_HEALTH_PORT` abre un servidor mínimo (Node `http`, sin Nest ni
  rutas) con **una** ruta, `GET /health`: `200 {"status":"ok"}` si la última
  vuelta del bucle terminó hace menos de **3 × `JOBS_POLL_INTERVAL_MS` +
  `statement_timeout`** (el de la conexión, leído al arrancar; 0 si no hay),
  `503 {"status":"stale"}` si no, y `200 {"status":"stopping"}` durante el
  apagado. Cualquier otra ruta, 404. Detecta un bucle **bloqueado** (una
  sentencia que nunca vuelve); una BD caída no la tumba (reiniciar el worker
  no arregla la BD: eso se ve en `stats`, sin latido). Decisión: httpGet
  frente a un fichero de latido en `/tmp` leído con `exec`, porque no
  necesita shell en la imagen ni escribir en disco y se prueba con `curl`.
  Sin `JOBS_HEALTH_PORT` no se abre nada. Con `APP_ROLE=all` la API conserva
  sus sondas (`/api/v1/health`, `/api/v1/health/ready`), que **no** dependen
  del worker, y `JOBS_HEALTH_PORT` tiene que ser otro puerto. En Kubernetes:

  ```yaml
  # Deployment del worker (APP_ROLE=worker, JOBS_HEALTH_PORT=9464)
  livenessProbe:
    httpGet: { path: /health, port: 9464 }
    periodSeconds: 10
    failureThreshold: 3
  ```

  **Latido y `stats`.** En cada vuelta el worker hace upsert de su fila en
  `job_workers` (id = `lockedBy` de sus trabajos, papel, `APP_VERSION` y
  `lastBeatAt`); la purga diaria borra los que llevan 7 días sin latir. `GET
  /api/v1/platform/jobs/stats` (solo superadmin con token de plataforma; 403
  a cualquier rol de clínica) devuelve, sin payloads ni datos de pacientes:

  | Campo | Qué es |
  |-------|--------|
  | `queue.pendingDue` / `pendingScheduled` | PENDING cuya hora llegó / programados para después |
  | `queue.lagMs`, `oldestDueRunAt` | Retraso: ahora − `min(runAt)` de los PENDING vencidos |
  | `queue.running`, `runningExpired` | RUNNING y los que tienen el arriendo vencido |
  | `queue.failedLast24h` | FAILED en las últimas 24 h |
  | `workers.alive`, `lastBeatAt`, `recent[]` | Workers con latido de menos de 60 s; los 50 más recientes |
  | `schedules[]` | Por tarea: `cron`, `lastRunAt`, `nextRunAt`, `periodMs`, `delayMs` y `overdue` (más de **2 periodos** sin correr, o sin sincronizar: `nextRunAt` null). DX-380: `singleton`, `skippedCount` y `lastSkippedAt` (ticks saltados porque el anterior seguía en curso) |

  ```bash
  curl -s -H "Authorization: Bearer $PLATFORM_TOKEN" \
    http://localhost:3000/api/v1/platform/jobs/stats | jq
  ```

  **Reencolar un fallido.** `POST /api/v1/platform/jobs/:id/retry` (solo
  superadmin) devuelve un FAILED a PENDING con `attempts = 0` para ya.
  Conserva su `idempotencyKey`, que el índice único `(tenantId,
  idempotencyKey)` garantiza que no tiene ninguna otra fila: no duplica el
  trabajo. Una sola vez: si ya no está FAILED (otro reintento, o dos a la vez)
  da **409**; 404 si no existe (o ya se purgó). Queda en
  `platform_audit_events` (`JOB_RETRIED`: actor, id del trabajo, nombre,
  clínica, intentos y tipo de error; **sin el payload**). La respuesta
  tampoco lo lleva.

  **Fila envenenada (OPS-030).** Un trabajo RUNNING con el arriendo vencido
  que ya gastó sus intentos (`attempts >= maxAttempts`: su worker murió o su
  cierre falló por un corte de BD) lo cierra `failExhausted` en cada vuelta,
  **antes** del reclamo, como FAILED `LeaseExpired` sin sumar intento; y el
  reclamo ignora cualquier fila con `attempts > maxAttempts`. Antes, una sola
  de esas filas hacía que el reclamo (una sentencia para todo el lote)
  violara `jobs_attempts_check` en cada vuelta y en cada worker.

  **No salen recordatorios: qué mirar**, en orden:

  1. `stats` → `workers.alive`. Si es 0, no hay worker vivo: ¿está
     desplegado con `APP_ROLE=worker`? ¿Lo reinicia el orquestador en bucle
     (sonda `/health` en 503, `kubectl describe pod`)? ¿Llega a la BD (logs
     `jobs.poll_failed`, `jobs.worker_beat_failed`)? Un recordatorio que sale
     más de 1 h tarde se descarta (`TOO_LATE`, DX-026).
  2. `schedules[]` → `reminders.plan.every-5-min`. `overdue: true` con
     workers vivos: ninguno la dispara. ¿El worker vivo es de una versión que
     no la conoce (`workers.recent[].version`) o con otro cron (despliegue a
     medias: solo dispara la réplica cuyo cron coincide con la fila)?
     `nextRunAt: null`: ningún worker la ha sincronizado.
  3. `queue.pendingDue` y `lagMs` creciendo con workers vivos: el worker no
     da abasto (`JOBS_CONCURRENCY`, más réplicas) o está atascado en
     trabajos largos (`queue.running`, `runningExpired`).
  4. `queue.failedLast24h` > 0: `GET /platform/jobs/failed` (`lastError`
     con tipo y código, p. ej. el SMTP caído) y, arreglada la causa, `POST
     /platform/jobs/:id/retry`.
  5. Todo sano y aun así no llega: el recordatorio se planificó pero el
     email no salió. Mira `outbound_messages` de la cita y `email_outbox`
     (DX-088), o si el paciente se dio de baja (DX-128).
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

  **Una ejecución a la vez (DX-380, OPS-046).** Con `singleton: true`, si el
  trabajo de un tick anterior de la tarea sigue en `PENDING` o `RUNNING`, el
  tick no encola nada: la tarea pasa al tick siguiente y suma un salto
  (`job_schedules."skippedCount"` y `"lastSkippedAt"`), en la misma
  transacción de `fireDueSchedules` y con la fila de la tarea bloqueada. Queda
  en el log (`jobs.schedule_skipped`, con el nombre de la tarea) y en
  `stats`. Así un barrido que tarda más que su periodo no se solapa consigo
  mismo ni llena los huecos del worker. Lo usan el barrido de imputaciones,
  el regional de G1, los recordatorios, los compromisos de pago y las purgas
  (tokens, emails, enlaces de baja y trabajos terminados). Un `RUNNING` cuyo
  worker murió frena los ticks hasta que otro lo retoma o lo cierra
  `failExhausted` (el arriendo, 300 s). El índice parcial
  `jobs_active_name_idx` (`name` de los `PENDING`/`RUNNING`) acota la
  comprobación. Una réplica anterior a DX-380 sigue disparando cada tick.

  | Tarea | Cron (UTC) | Qué hace |
  |-------|------------|----------|
  | `auth.purge-expired-tokens.hourly` | `17 * * * *` | Borra `revoked_tokens` y `pending_registrations` vencidos y `user_tokens` caducados/usados hace > 7 días. Sustituye a la limpieza lazy de cada logout/refresh |
  | `email.purge-outbox.daily` | `23 4 * * *` | Borra de `email_outbox` los SENT/FAILED de más de `MAIL_OUTBOX_RETENTION_DAYS` (90), clínica a clínica bajo su RLS, y los de plataforma por `email_outbox_purge_platform` (DX-144) |
  | `exchange.prefetch-rates.daily` | `5 0 * * *` | Precarga los tipos de cambio del día UTC (si hay `EXCHANGE_APP_ID`), fuera de los presupuestos de SEC-054; la petición conserva el `fetch` como respaldo |
  | `jobs.purge-finished.daily` | `41 3 * * *` | Borra los trabajos terminados de más de `JOBS_RETENTION_DAYS` |
  | `collections.settle-promises.hourly` | `7 * * * *` | Cierra los compromisos de pago (DX-150): `KEPT` si los abonos registrados desde el compromiso y fechados hasta su día (zona de su sede) cubren el importe; `BROKEN` desde el día siguiente. Regla diaria, barrida cada hora para respetar la medianoche de cada sede; idempotente y auditada sin usuario (`origin: JOB`). El abono que cubre un compromiso lo cierra además en el acto; anular ese abono lo reabre (DX-215). Cada cierre relee con el candado del paciente |
  | `domains.recheck-sweep.hourly` | `29 * * * *` | Re-verifica el TXT de cada dominio personalizado VERIFIED (consulta el DNS de toda la ronda y encola un `domains.recheck` por dominio, en su clínica); desactiva los que fallan `DOMAIN_RECHECK_MAX_FAILURES` veces seguidas (SEC-009). Si falla más de la mitad (y son ≥ 4), la ronda no cuenta (`domains.recheck_suspect`, DX-220) |
- **Tablas**: `jobs` y `job_schedules` son de PLATAFORMA, sin RLS (exención
  documentada en `test/rls-catalog.int-spec.ts`): un worker reclama trabajos de
  todas las clínicas. `job_workers` (latido) y `platform_audit_events`
  (acciones de plataforma del superadmin, append-only) también, y sin columna
  de tenant (lista `PLATFORM_TABLES` del mismo spec; DX-220). `outbound_messages` es por clínica con RLS forzada: el
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

## Política de cancelación e inasistencias (DX-279)

Porción 1: la política por sede, quién y cuándo canceló, si fue tardía y el
resumen de asistencia del paciente. Mostrar la política al paciente (recordatorio
y enlace con `acknowledgePolicy`), rellenar `policyVersionId` y el cargo o su
condonación son DX-291 (sección siguiente).

- **Tabla `cancellation_policy_versions`** (RLS FORCE, FK compuesta a la sede,
  moneda del catálogo): horas de aviso 0–168, importe sugerido ≥ 0 con su
  moneda (los dos o ninguno), texto para el paciente ≤ 1000 y
  `receptionCanCharge` (lo usará DX-291). **Append-only**: la app no tiene
  UPDATE/DELETE/TRUNCATE y el trigger `cancellation_policy_versions_immutable`
  los rechaza (DELETE/TRUNCATE solo a un superusuario, para limpiar bases de
  test; no hay purga administrativa). La vigente es la de mayor
  `version`.
- **Endpoints** (solo ADMIN, 403 «Solo un administrador puede ver y cambiar la
  política de cancelación.»): `GET /locations/:id/cancellation-policy` →
  `{ locationId, current, versions }` y `POST` con `{ noticeHours,
  suggestedFee?, currency?, patientText?, receptionCanCharge? }`, que crea la
  versión siguiente (sede bloqueada: dos guardados a la vez no repiten número).
  400 en español; otra clínica: 404. Queda en `audit_events`
  (`CREATE`, `CANCELLATION_POLICY`, `CANCELLATION_POLICY_CHANGED`).
- **Columnas de `appointments`**: `cancelledAt`, `cancelledByKind`
  (`PATIENT_LINK | STAFF_FOR_PATIENT | CLINIC`), `cancelReasonCode` (ILLNESS,
  FORGOT, COST, TRANSPORT, WORK, CLINIC_RESCHEDULE, OTHER), `cancelReasonText`
  (≤ 500), `noticeMinutes`, `lateCancellation`, `noShowMarkedAt` y
  `policyVersionId` (FK compuesta; NULL hasta DX-291). CHECK
  `appointments_cancellation_check`: solo una cita CANCELLED lleva datos de
  cancelación; hora, quién, aviso y tardía van juntos (las canceladas antiguas
  no tienen ninguno y siguen siendo válidas); el personal siempre da motivo;
  aviso ≥ 0; la clínica nunca es tardía; `noShowMarkedAt` solo en NO_SHOW.
- **Cancelar** (`PATCH /appointments/:id` a CANCELLED) exige
  `cancelledByKind` (`STAFF_FOR_PATIENT` o `CLINIC`) y `cancelReasonCode` (400
  si faltan); `cancelReasonText` es opcional. El servidor fija la hora y, con la
  fila bloqueada, calcula en UTC los minutos de aviso (hacia abajo, 0 si la
  cita ya empezó) y si es tardía (aviso **menor** que las horas de la política
  vigente de la sede de la cita; exactamente las horas no lo es; sin política,
  si cancela la clínica o si la cita estaba en la clínica —llegó, en sillón,
  listo para cobrar— o completada, nunca). Un cambio de hora no lo altera: se
  cuenta el tiempo real. Cancelar y mover en el mismo PATCH da 400. Queda
  auditado con un solo evento: `APPOINTMENT_CANCELLED` (o, desde la clínica, el
  de flujo `PATIENT_FLOW` y, desde «Completada», `COMPLETED_EXIT`), con
  `cancellation` = origen, código del motivo, aviso y tardía; nunca el texto. Marcar NO_SHOW guarda
  `noShowMarkedAt`; salir de CANCELLED o NO_SHOW borra sus datos. El enlace
  público (DX-005) que cancela guarda `PATIENT_LINK`, la hora de la respuesta,
  el aviso y si es tardía (sin motivo ni aceptación todavía). Reagendar o
  adelantar a un hueco no cancela nunca. `GET
  /appointments/:id/cancellation-preview` da el aviso si se cancelara ahora.
- **Resumen**: `GET /patients/:id/attendance-summary` (los cuatro roles):
  citas ya empezadas, inasistencias y cancelaciones tardías cuyo inicio cae en
  los últimos 12 meses, por sede y en total, calculado al pedirlo. Un miembro
  restringido (DX-089) solo cuenta sus sedes (sin mirar la cabecera). `GET
  /appointments` trae `attendance` por cita con la misma regla, en una sola
  consulta para todo el lote (índice parcial
  `appointments_tenant_patient_incidents_idx`), y omite `cancelReasonText`.
- **Demo**: la sede principal tiene una política de 24 h con cargo sugerido de
  50.000 COP, y Daniela Montoya Arango tiene dos inasistencias y una
  cancelación con 5 h de aviso la semana pasada (insignia en su ficha y en sus
  citas). Las cancelaciones del calendario se registran avisadas por el
  paciente con 2 días.

## Política comunicada y cargo por inasistencia (DX-291)

Porción 2 de DX-279: probar que el paciente fue informado y cobrar (o
condonar) el cargo con el flujo de plan, abono y recibo de siempre.

- **Recordatorio** (DX-026): el email `appointment-reminder` lleva la variable
  `{politica_cancelacion}` (`vars.cancellationPolicy`: horas de aviso, texto
  de la clínica e importe formateado) con la política VIGENTE de la sede al
  enviarlo; sin política, el bloque no sale. Antes de encolarlo se guarda la
  versión en `appointment_reminders."policyVersionId"` y en
  `appointments."policyVersionId"` (la comunicada; FK compuestas).
- **Enlace público** (DX-005): `GET /public/appointment-confirmations/:token`
  devuelve además `cancellationPolicy` (`policyVersionId`, `noticeHours`,
  `text`, `suggestedFee`, `currency`; solo con el enlace PENDING) e `isLate`
  (cancelar ahora tendría menos aviso que la política). Nada clínico. En el
  `POST`, cancelar tarde exige `acknowledgePolicy: true` (400 «Cancelación con
  menos de N h de aviso: para cancelar, acepta la política…»); confirmar y
  «Quiero que me llamen» no. Si la página manda `policyVersionId` y ya no es
  la vigente: 409 (la página se recarga). Toda respuesta guarda la versión
  vigente como comunicada; cancelar guarda `PATIENT_LINK`, el aviso y si fue
  tardía (DX-279), con la cita bloqueada y en la misma transacción.
- **Cargo**: `GET /appointments/:id/cancellation-fee` (estado, bloqueo y si
  el usuario puede decidir), `POST /appointments/:id/cancellation-fee`
  (`{ amount? }`) y `POST …/cancellation-fee/waive` (`{ reason }`, 3–500).
  ADMIN y RECEPTION pasan el guard; RECEPTION solo escribe si la política
  VIGENTE de la sede tiene `receptionCanCharge` (403 en español). Solo una cita
  NO_SHOW o cancelada tarde. El cargo crea (o reutiliza) el plan ACCEPTED
  «Cargos administrativos» (`optionLabel`) del paciente en la moneda de la
  versión COMUNICADA y le añade un ítem DONE (procedimiento inactivo
  `ADM-CANCELACION` del catálogo de la clínica, sin diente, `completedAt` y
  sede de la cita, sin profesional) con el importe sugerido o menos (más: 400).
  Sale en el estado de cuenta y se cobra con `POST /treatment-plans/:id/payments`
  y su recibo consecutivo (DX-136). Condonar (antes de generar el cargo) deja
  la decisión con su motivo. El ítem no admite descuento (`allowDiscount =
  false`, y un plan aceptado no se vuelve a descontar, DX-204); un cargo
  generado por error se **anula** desde la cita (SEC-050, abajo) y la cita
  conserva su única decisión. 409 en español: no es inasistencia ni tardía, «No
  consta que el paciente fuera informado de la política» (sin
  `policyVersionId`), la versión comunicada no tiene importe, ya cobrado o
  condonado, o la cita cambió. El cargo se calcula igual para cualquier
  paciente, tenga la cobertura que tenga, y no depende de la zona de la sede
  (DX-321); para no cobrar a alguien está la condonación, con motivo.
- **Anular un cargo generado (SEC-050)**: `POST
  /appointments/:id/cancellation-fee/void` (`{ reason }`, 3–500), con el mismo
  permiso que generarlo (ADMIN, o RECEPTION si la política vigente lo permite)
  y la sede de la cita permitida (DX-089, 403). En una transacción, con la
  cita y la fila del cargo bloqueadas, guarda en el cargo `voidedAt`,
  `voidedById` y `voidReason` y DESPUÉS retira el ítem del plan (sale del
  estado de cuenta). Una vez (409 «ya se anuló»); sin cargo generado, 409; si
  los abonos vivos del plan ya no caben en lo que queda por cobrar, 409 «Anula
  antes el abono». Esa suma va en la moneda del plan (DX-382, BE-046): cada
  abono cuenta por su base de imputación (`payment_plan_amounts.amount`,
  DX-051, con la tasa que congeló, DX-375), nunca por su importe en otra
  moneda; si algún abono vivo del plan no tiene base («sin tasa», o con tasa
  pero aún sin la base que crea el barrido de cada minuto), 409 «Hay abonos
  todavía sin convertir a la moneda del plan; registra la tasa del día o espera
  un minuto y vuelve a intentarlo». Candados en
  el orden R6: plan (FOR UPDATE, para que un abono nuevo espere) → sus bases
  ORDER BY `paymentId` → el ítem del cargo; las sumas, después. La vista pasa a `status: VOIDED` con quién, cuándo y el
  motivo. Auditoría `VOID APPOINTMENT` `CANCELLATION_FEE_VOIDED` con
  `statusChange` CHARGED → VOIDED, sin el texto. Sin Idempotency-Key (como
  condonar): repetir da 409. **Desde el plan**, el ítem de un cargo vigente
  (`cancellationFeeAppointmentId` en el ítem) no cambia de precio, descuento
  (ni su motivo) ni estado, ni se quita, para ningún rol (409 en español), y
  su plan no se cancela ni cambia de moneda (completarlo sí); las notas sí. La
  vista del cargo trae `fee.itemAmount` (lo que cobra hoy el ítem) e
  `itemMismatch` (no cuadra con `amount`: se cambió por fuera de este flujo).
  Red en la BD (migración `20261024150000_sec050_cancellation_fee_void`):
  triggers `treatment_plan_items_cancellation_fee_locked` y
  `treatment_plans_cancellation_fee_locked` (restrict_violation → 409; sin
  `app.current_tenant` no aplican, como los de DX-109). **Cómo pasa la
  anulación legítima**: no hay variable de sesión; el trigger del ítem mira
  en la misma transacción si el cargo sigue vigente (CHARGED y `voidedAt`
  NULL), y el caso de uso anula el cargo antes de retirar el ítem. En un plan ya
  completado también: `treatment_plan_items_locked_when_closed` (DX-109) deja
  retirar solo el ítem de un cargo ya anulado, sin otro cambio (migración
  `20261024150400_sec050_void_fee_in_closed_plan`). Para tocar
  el ítem hay que dejar antes la anulación, con autor y motivo. Un cargo con
  `planItemRemoved = true` y sin `voidedAt` es anterior a SEC-050 (se quitó
  con «Quitar»).
- **Tabla `cancellation_fees`**: una fila por cita (único
  `(tenantId, appointmentId)`), RLS FORCE, append-only para la app (sin
  DELETE; el único UPDATE es la anulación: GRANT solo de `voidedAt`,
  `voidedById` y `voidReason`, y trigger `cancellation_fees_append_only`, que
  impide borrar la fila, vaciar la tabla (`cancellation_fees_no_truncate`)
  o reescribir cualquier otra columna aunque la app tuviera
  UPDATE/DELETE/TRUNCATE de más, DB-052; un superusuario sí borra), CHECK
  `cancellation_fees_void_check` (las tres juntas, solo en CHARGED), FK compuestas a la cita, al ítem (por paciente), a la sede y
  a la versión, y CHECK `cancellation_fees_status_check` (CHARGED: importe > 0,
  moneda, ítem y versión; WAIVED: solo el motivo). **Idempotencia**: el cargo
  bloquea la cita (`FOR UPDATE`) y el paciente (para no crear dos planes) y el
  índice único es el respaldo: varias peticiones a la vez dejan una sola 201 y
  las demás 409 (`test/cancellation-fee.int-spec.ts`).
- **Auditoría**: `@Audit` sobre la cita: `CREATE APPOINTMENT`
  `CANCELLATION_FEE_CHARGED`, `UPDATE APPOINTMENT` `CANCELLATION_FEE_WAIVED`
  y `VOID APPOINTMENT` `CANCELLATION_FEE_VOIDED` (SEC-050), con el paciente;
  nunca el texto del motivo.
- **Fecha de cierre (DX-091)**: aún no hay bloqueo contable; el ítem y el
  abono se fechan con la hora del servidor (hoy), así que nunca caen en un
  período anterior.
- **Vista previa** (Ajustes → Sedes, solo ADMIN): `GET
  /locations/:id/cancellation-policy/email-preview` → `{ subject, html, text }`
  del recordatorio con la marca de la clínica y la política vigente (paciente
  y profesional de ejemplo). No envía nada.
- **Demo**: las dos inasistencias y la cancelación tardía de Daniela Montoya
  Arango tienen la política comunicada y se pueden cobrar. La inasistencia de
  Jorge Eduardo Ramírez Ospina (hace 8 días) también tiene la política
  comunicada: ahí «Generar cargo» funciona igual como ADMIN.

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
- **Email**: fecha y hora con la zona, el formato y el reloj de la sede, sede, profesional y botón «Confirmar o
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

## Canal de contacto y baja de recordatorios (DX-128)

Canal OPERATIVO de los avisos automáticos (no el consentimiento de marketing
de DX-037). Migración `20261017233300_dx128_contact_channel`.

- **Datos**: `patients.contactChannel` (`EMAIL` | `WHATSAPP` | `NONE`; nace
  con `tenants.defaultContactChannel`, hoy `EMAIL` en todas las clínicas y sin
  pantalla para cambiarlo), opt-in de WhatsApp (`whatsappOptInAt`, `…Source`
  `IN_PERSON` | `LINK` | `MESSAGE`, `…ById`) y baja (`reminderOptOutAt`,
  `…Source` `LINK` | `MESSAGE` | `STAFF`), con CHECK de que fecha y origen van
  juntos. Los pacientes existentes migran con el canal de su clínica, sin
  opt-in ni baja; `phone` no se toca (el wa.me manual sigue igual).
- **Regla de elegibilidad** (`reminders/domain/reminder-eligibility.ts`): con
  baja no sale NINGÚN envío automático; canal `NONE`, nada; canal `WHATSAPP`,
  no se manda el email automático (el de WhatsApp llegará con DX-126 y exigirá
  opt-in y móvil válido; mientras, «Abrir WhatsApp» manual); canal `EMAIL` sin
  email, `NO_EMAIL`. El barrido aplica las tres primeras en SQL (esos
  pacientes no entran en la cola) y el handler la relee entera al enviar
  (motivos `OPTED_OUT`, `CHANNEL_NONE`, `CHANNEL_WHATSAPP`).
- **Ficha**: `GET /patients/:id/communication` (4 roles) y `PATCH` (solo
  RECEPTION y ADMIN; 403 en español). El móvil se valida y normaliza a E.164
  con la región telefónica por defecto de la sede activa o la principal
  (DX-329; sin región, se escribe con «+»); uno inválido se guarda con aviso, pero no puede ser canal
  WhatsApp (400 `WHATSAPP_REQUIRES_VALID_MOBILE`, también desde `PATCH
  /patients/:id`). Cada cambio deja un `audit_event` UPDATE de PATIENT con
  `reason: COMMUNICATION_PREFERENCES_CHANGED`, los campos y `origin`.
- **Baja por enlace**: cada email de recordatorio lleva su enlace
  `<host de plataforma>/baja/<token>` (32 bytes base64url; en la BD solo su
  SHA-256, `reminder_opt_out_links`, RLS FORCE y FK compuesta). `GET
  /public/reminder-opt-outs/:token` solo lee; `POST` registra la baja
  (idempotente) y la audita sin actor (`reason: REMINDER_OPT_OUT`, `origin:
  LINK`; `audit_events_actor_check` admite actor NULL solo para eso y el
  login fallido). Mismo límite por IP que la confirmación.
- **Baja por mensaje**: `OptOutByMessageUseCase` (exportado por
  `RemindersModule`) reconoce «BAJA», «STOP» y «NO MÁS» (sin tildes ni
  mayúsculas, mensaje entero) y da de baja a todos los pacientes vivos de la
  clínica con ese móvil (prefiltro por la columna `phoneTail`, que mantiene
  un trigger, con el índice parcial `patients_tenant_phone_tail_idx`: DX-225), con origen
  MESSAGE. Lo invocará el webhook de WhatsApp de DX-126, que aún no existe.
- **Menores**: desde DX-203 los avisos de un menor (o de un paciente sin
  email) van al email de su **responsable** (ver la sección siguiente). Sin
  responsable con email, el de la ficha saluda al responsable o, sin él, a su
  contacto principal (`emergencyContactName`), como Dentrix Ascend («Te
  recordamos la cita de Mateo»); la ficha lo muestra (`recipient` en `GET
  /patients/:id/communication`).
- **Demo**: `seed:demo` deja a Laura con WhatsApp y opt-in en persona, al
  tercer paciente con canal ninguno, al cuarto dado de baja y al quinto con un
  fijo (móvil no válido). Sofía Ortiz (menor) muestra los avisos dirigidos a
  su madre Claudia.

## Responsable de pago y grupo familiar (DX-203)

Quién paga y quién recibe los avisos de un paciente (el acudiente de un
menor, la madre que paga a sus hijos), como el garante de Open Dental o
Dentrix. Módulo `patients`, tabla `patient_responsible_parties`; migraciones
`20261018150000_dx203_patient_responsible_parties` y
`20261018150100_dx203_guardian_to_responsible`.

- **Datos**: el responsable es OTRO paciente de la clínica
  (`responsiblePatientId`; nombre, documento, email y teléfono salen de su
  ficha) o un contacto sin ficha (nombre, tipo y nº de documento, email,
  teléfono). Con `relationship`, `isPayer` (pagador principal) y
  `receivesNotices`. RLS FORCE, FK COMPUESTAS a `patients` por las dos
  columnas (vincular a un paciente de otra clínica es imposible en la BD) y
  CHECK de forma. Índices únicos parciales: un pagador principal vivo por
  paciente y el mismo paciente responsable una sola vez. Se quita en blando.
  Datos de un tercero bajo la autorización del paciente (finalidad «gestión de
  cobro y avisos»): no crea usuario ni acceso al portal.
- **Endpoints** (los 4 roles, como «Editar» de la ficha; recepción lo
  gestiona sin ver la historia): `GET|POST /patients/:patientId/responsible-parties`
  y `PATCH|DELETE …/:partyId`. 404 si el paciente o el paciente responsable
  no son de la clínica, 409 el mismo paciente dos veces, 422 en español un
  segundo pagador o más de 5 responsables. El GET trae también
  `responsibleFor` («Responsable de: …»), si es menor y a quién van hoy sus
  avisos. Auditoría: UPDATE de PATIENT con `reason`
  `RESPONSIBLE_PARTY_ADDED|CHANGED|REMOVED` y los nombres de los campos.
- **Regla de destinatario**
  (`patients/domain/communication/notice-recipient.ts`): un paciente MENOR
  (por debajo de la mayoría de edad de la clínica, `tenants."majorityAge"`
  —DX-328—, contada en el día civil de la sede) o SIN email recibe el
  recordatorio (DX-026), el recibo (DX-136), el estado de cuenta (DX-011) y
  las indicaciones postoperatorias por email (DX-222) en el email de su
  responsable que recibe avisos, primero el pagador. La edad se lee en cada
  envío: un recordatorio ya encolado usa el valor vigente al enviarse. El
  canal y la baja del PACIENTE (DX-128) se respetan igual; en el
  recordatorio automático, tampoco recibe un paciente
  responsable dado de baja o con canal distinto de EMAIL. El registro de
  envíos (`outbound_messages."recipientKind"`) y el estado de los
  recordatorios (`sentToResponsible`) dicen «enviado al responsable»; `POST
  /payments/:id/receipt/email` devuelve `sentToResponsible`; el estado de
  cuenta trae `addressee` (a nombre de quién sale).
- **Estado de cuenta familiar**: `GET
  /patients/:patientId/family-account-statement` (ADMIN y RECEPTION) del
  pagador: su saldo y el de cada paciente del que es pagador principal, con
  subtotal por paciente y moneda (el MISMO `computeAccountStatement` que el
  individual, sobre la misma lectura) y el total en céntimos. Solo importes y
  nombres; solo lectura (no hay abono familiar). Auditoría VIEW de
  ACCOUNT_STATEMENT con `reason: FAMILY_ACCOUNT_STATEMENT`.
- **Acudiente antiguo**: `patients.guardianName/guardianDocNumber` quedan
  DEPRECADOS y de solo lectura (la API ya no los escribe; un cliente antiguo
  que los mande no da error). La migración copió cada valor a un contacto
  responsable `LEGAL_GUARDIAN` que recibe avisos y no paga, de forma
  idempotente (índice único parcial `migratedFromGuardian`) y sin tocar las
  columnas viejas.
- **Demo**: la abuela Martha Lucía Becerra paga a Sofía Ortiz y a Mateo
  Cifuentes (su ficha muestra «Responsable de» y el estado de cuenta
  familiar); los avisos de Sofía van a su madre Claudia (contacto) y los de
  Mateo a la abuela.

## Mayoría de edad de la clínica (DX-328)

La edad desde la que un paciente es adulto la fija cada clínica en
`tenants."majorityAge"` (entero, CHECK 14..21). La leen el bloque
«Responsable y familia» y la regla de destinatario de arriba. Ningún código
la deduce del país de una sede. Migraciones `20261028160000_dx328_enums`,
`20261028160100_dx328_audit_events_idx`,
`20261028160200_dx328_tenant_majority_age` y
`20261028160300_dx328_tenant_majority_age_backfill`.

- **Valor inicial**: una clínica nueva empieza en 18
  (`PLATFORM_DEFAULT_MAJORITY_AGE`). Las que ya existían conservan la edad que
  cada clínica ya aplicaba (la mayor si tenía varias); ver
  [la migración de relleno](prisma/migrations/20261028160300_dx328_tenant_majority_age_backfill/migration.sql).
- **Endpoints**: `GET /patients/settings` (los 4 roles) devuelve
  `{ majorityAge }`. `PUT /patients/settings` solo lo usa el ADMIN
  (`CLINIC_SETTINGS_WRITE_ROLES`); cualquier otro rol recibe 403 «Solo un
  administrador puede cambiar la mayoría de edad.». El cuerpo es
  `{ majorityAge }`, un entero de 14 a 21. Si el valor está fuera de rango, es
  decimal, es texto o falta, la respuesta es 400 con «La mayoría de edad
  tiene que ser un número entero de años entre 14 y 21.». Las dos rutas
  están declaradas antes de `GET /patients/:id`.
- **Escritura**: lee la fila de la clínica con `FOR UPDATE` y la actualiza en
  la misma transacción. Así, dos ADMIN a la vez dejan dos cambios
  encadenados. El cambio aplica desde la siguiente petición, porque no hay
  caché. Lo ya enviado no se rehace.
- **Auditoría**: solo si el valor cambia. Es un UPDATE de `CLINIC_SETTINGS`
  sin recurso ni paciente, con `reason: MAJORITY_AGE_SETTINGS` y
  `statusChange` `AGE_<antes>` → `AGE_<después>`. Guardar el mismo valor
  responde 200 sin evento.
- **Despliegue** (orden obligatorio):
  1. `npx prisma migrate deploy` aplica las cuatro migraciones y tiene que
     terminar ANTES de que arranque la primera réplica nueva de la imagen,
     sea de la API (`APP_ROLE=api`) o del worker (`APP_ROLE=worker`): el
     worker también lee la columna al enviar cada recordatorio
     (`loadTenantMajorityAge`). Una réplica nueva contra el esquema anterior
     falla en cada lectura de `tenants` que pide `majorityAge`; en el worker,
     el trabajo falla y la cola lo reintenta, así que el recordatorio se
     retrasa (o queda FAILED si la espera agota sus intentos). Las réplicas
     antiguas no leen la columna y siguen funcionando con el esquema nuevo.
  2. Si falla el relleno (`20261028160300_dx328_tenant_majority_age_backfill`),
     se para el despliegue y NO se despliega la API ni el worker. Se ejecuta
     `npx prisma migrate resolve --rolled-back 20261028160300_dx328_tenant_majority_age_backfill`,
     se corrige la causa y se repite `migrate deploy`. Si se sigue adelante,
     todas las clínicas quedan en 18 (el default de la columna), y las que
     aplicaban 16 pasan a tratar en silencio como menores a los pacientes de
     16 y 17 años.
  3. Esperas de bloqueo: `lock_timeout` de 5 s en el enum, en el índice y en
     la columna de `tenants`, y de 10 s en el relleno. El relleno toma
     `ACCESS EXCLUSIVE` en `locations` (quita y devuelve FORCE) y en
     `tenants` solo bloqueos de fila; el `lock_timeout` acota las dos
     esperas. Mientras el relleno espera su bloqueo (hasta 10 s), las
     peticiones que leen sedes (casi todas: la zona de la sede, la agenda,
     los avisos) hacen cola detrás de él; es otro motivo para la hora de
     poco tráfico.
  4. Un fallo por bloqueo es benigno, no un problema de datos: si se agota
     el `lock_timeout`, o Postgres aborta el relleno por un interbloqueo
     (deadlock) con una transacción de una réplica antigua que tenía la fila
     de una clínica, la migración falla sin dejar nada a medias. Se ejecuta
     `npx prisma migrate resolve --rolled-back <migración>` (la que nombre
     `npx prisma migrate status`) y se repite `migrate deploy`; no hay causa
     que corregir.
  5. El índice parcial de `audit_events` (`…160100`) no es concurrente,
     porque la tabla está particionada. Mientras se construye, bloquea las
     escrituras de auditoría durante un momento, así que conviene desplegar a
     una hora de poco tráfico.
  6. **Vuelta atrás: se corrige hacia delante, no se revierte.** Los datos
     aguantan la API anterior: la columna, el valor del enum y el índice se
     quedan, y esa API no lee ni escribe `majorityAge`. Pero en cuanto un
     ADMIN ha cambiado la mayoría de edad (hay una fila `CLINIC_SETTINGS` en
     `audit_events`), la API anterior, en esa clínica:
     - devuelve 500 en `GET /audit-events` en cuanto la página incluye esa
       fila (sin filtros, la primera, porque va de la más reciente a la más
       antigua): su cliente de Prisma no conoce el valor `CLINIC_SETTINGS`
       de `AuditResourceType`;
     - vuelve a la edad que salía del país de cada sede y deja de lado la
       que fijó la clínica, sin avisar a nadie.

     Las dos cosas terminan al volver a desplegar la API nueva, sin tocar
     datos; lo enviado mientras tanto no se rehace. Las clínicas que nunca
     cambiaron la edad vuelven a la regla de antes del despliegue, nada más.
     Si la vuelta atrás es inevitable: no se revierte ninguna migración ni se
     tocan filas de `audit_events` (es de solo inserción); se sacan las
     clínicas afectadas con la consulta de abajo (solo lectura, con un rol
     BYPASSRLS o superusuario) y se avisa a sus ADMIN de los dos efectos; si
     la web nueva sigue desplegada, Ajustes › Mayoría de edad muestra un
     error con reintento (la API anterior no tiene la ruta); y se vuelve a
     desplegar la API nueva en cuanto se pueda.

     ```sql
     BEGIN TRANSACTION READ ONLY;
     SET LOCAL row_security = off;
     SELECT t.id, t.subdomain, t."majorityAge",
            max(a."occurredAt") AS "lastChange"
     FROM audit_events a
     JOIN tenants t ON t.id = a."tenantId"
     WHERE a."resourceType" = 'CLINIC_SETTINGS'
     GROUP BY t.id, t.subdomain, t."majorityAge"
     ORDER BY t.subdomain;
     ROLLBACK;
     ```

## Tasa de cambio por clínica: automática o manual (DX-374)

Porción 1 de DX-367. Cada clínica elige de dónde sale la tasa del día con la
que se convierten saldos, totales e imputaciones: `tenants."exchangeRateSource"`
(`AUTOMATIC` por defecto, el proveedor de siempre con su caché
`exchange_rate_snapshots`; o `MANUAL`). Con `MANUAL` la tasa sale de
`manual_exchange_rates`, que registra el ADMIN por día civil y moneda, en
unidades de la moneda por 1 USD (la misma base que el proveedor). Migraciones
`20261101120000_dx374_enums`, `20261101120100_dx374_audit_events_idx`,
`20261101120200_dx374_tenant_exchange_rate_source`,
`20261101120300_dx374_manual_exchange_rates`,
`20261101120400_dx374_tenant_manual_rates_since` y
`20261101120500_dx374_manual_exchange_rates_utc`. Sin relleno: toda clínica
existente queda en `AUTOMATIC` y no cambia nada para ella.

- **Día de inicio** (`tenants."manualExchangeRatesSince"`, DATE, CHECK: no
  nulo si y solo si la fuente es `MANUAL`): pasar a `MANUAL` lo fija en hoy
  en la zona de la sede principal; guardar `MANUAL` otra vez lo conserva;
  volver a `AUTOMATIC` lo limpia. La tasa de un día D sale de las manuales
  solo con `MANUAL` y D >= ese día; los días anteriores siguen con la
  automática (caché y, si falta, el proveedor, con las protecciones de
  SEC-054: ventana, caché negativa, single-flight y presupuesto de la
  clínica). Así, pasar a `MANUAL` no mueve
  los saldos ni los totales de antes del cambio. Desde DX-375 cada abono
  congela su tasa (sección siguiente), así que ni pasar a `MANUAL` ni volver
  a `AUTOMATIC` mueve un abono ya cobrado.

- **Lectura** (`GetRatesForDateUseCase`, la que usan todas las conversiones):
  devuelve `{ base: 'USD', source, rates }`. Con `MANUAL` (y un día desde el
  de inicio), `rates` trae solo las monedas con tasa registrada ESE día: una moneda que falta está «sin
  tasa». No se toma la de otro día ni se llama al proveedor. Convertirla lanza
  `MissingExchangeRateError` (400 `EXCHANGE_RATE_MISSING`, en español). Los
  consumidores (`paymentInPlanCurrency`, `GetPaymentsTotalsUseCase`) la tratan
  igual que una moneda que el proveedor no trae (`isMissingRateError`): el
  abono queda sin base y el saldo responde 200 sin contarlo. La precarga diaria
  (`exchange.prefetch-rates`) usa `prefetchProviderRates`, que ignora la
  fuente de las clínicas y queda fuera de los presupuestos de SEC-054. `source` va en la respuesta para que DX-375 lo congele en cada
  abono. El saldo del plan y los totales usan `ConvertAmountUseCase.memoized()`:
  leen los ajustes de la clínica y las tasas de cada día una vez por cálculo,
  no una vez por abono (mismo resultado).
- **Endpoints**: `GET /exchange/rates` y `GET /exchange/convert` son ahora
  rutas de clínica (los 4 roles, `TenantContextInterceptor`: hace falta el
  host de la clínica). Solo ADMIN (`EXCHANGE_RATE_SETTINGS_ROLES`; el resto,
  403 «Solo un administrador puede ver y cambiar la tasa de cambio de la
  clínica.»): `GET|PUT /exchange/settings` (responde `{ source, manualSince,
  baseCurrency }`; el cuerpo del PUT es `{ source }`),
  `GET /exchange/manual-rates?limit=` (las últimas, día más reciente primero;
  30 por defecto, 100 como mucho) y `POST /exchange/manual-rates`
  (`{ date, currency, rate }`).
- **Validación del alta**: tasa > 0, hasta 8 decimales y menos de 10.000.000;
  moneda de `currencies` y nunca USD (es la base); día `AAAA-MM-DD` que existe,
  desde 2000-01-01 y no posterior a hoy en la zona de la sede activa (o de la
  principal). Una tasa ya registrada para ese día y moneda no se sobrescribe:
  409 `MANUAL_EXCHANGE_RATE_TAKEN`; si ningún abono la usó, se corrige con
  `PUT /exchange/manual-rates/:id` (DX-375). Se puede
  registrar con la fuente `AUTOMATIC`, para dejar la de hoy lista antes de
  cambiar a `MANUAL`. Quien no es miembro vivo de la clínica (acceso de
  soporte) recibe 403.
- **BD**: `manual_exchange_rates` con RLS FORCE y la política NULLIF; única
  por (`tenantId`, `date`, `currency`), que sirve también la lectura del día y
  la lista; FK de clínica, FK a `currencies` y FK compuesta del autor
  (`tenantId`, `createdByMembershipId`, `createdById`) →
  `clinic_memberships`; CHECKs de tasa > 0, moneda distinta de USD y día en
  rango. La app tiene SELECT, INSERT y UPDATE solo de `rate` (DX-375).
  `createdAt` lo pone en UTC un
  trigger BEFORE INSERT (DX-226), aunque el INSERT mande otra hora.
- **Auditoría**: cambiar la fuente deja un UPDATE de `CLINIC_SETTINGS` con
  `reason: EXCHANGE_RATE_SOURCE` y `statusChange` `AUTOMATIC` → `MANUAL` (o al
  revés), solo si cambia. Registrar una tasa deja un CREATE de `EXCHANGE_RATE`
  (`@Audit`) con el id de la tasa.
- **Despliegue**: `npx prisma migrate deploy` antes de la primera réplica
  nueva. El índice de auditoría no es concurrente (tabla particionada): a una
  hora de poco tráfico, como DX-316. Después, `npm run db:check-force`.
- **Fuera de alcance** de DX-374, hecho en DX-375 (sección siguiente):
  congelar en cada abono la tasa y su fuente, el aviso «sin tasa» y bloquear
  el cambio de una tasa ya usada.

## Cuota del proveedor de tasas (SEC-054)

La cuota del proveedor (`EXCHANGE_APP_ID`) es **una para toda la
plataforma**: si una clínica la agota, la precarga y los abonos en otra
moneda de todas las clínicas en `AUTOMATIC` se quedan «sin tasa». Todas las
llamadas pasan por `ProviderRatesGate`
(`src/modules/exchange/application/provider-rates-gate.ts`), detrás de la
caché de `exchange_rate_snapshots` de `GetRatesForDateUseCase`:

- **Fechas** (`GET /exchange/rates` y `/exchange/convert`): `date` tiene que
  ser un día que exista (`2026-02-30` o `2026-13-01`: 400 «date debe ser un
  día que exista, con el formato AAAA-MM-DD.», también `EXCHANGE_RATE_DATE_INVALID`
  desde el caso de uso; cubre BE-049 en estas rutas). Un día ya guardado se
  sirve siempre; uno sin guardar solo se pide al proveedor entre el alta de la
  clínica o su primer abono vivo (lo anterior) y hoy en la zona de sus sedes
  (la más adelantada). Fuera de ahí, 400 `EXCHANGE_RATE_DATE_OUT_OF_RANGE`
  con `first` y `today`, sin llamar a nadie. Las conversiones internas
  (saldos, abonos, barridos) no aplican la ventana: sus días ya son reales.
- **Caché negativa compartida**: un día que el proveedor no dio
  (`ExchangeRateUnavailableError`: HTTP no 2xx, red, tiempo agotado, forma
  inesperada) no se vuelve a pedir durante `EXCHANGE_NEGATIVE_CACHE_TTL_MS`
  (1 h), para ninguna clínica. La aprovecha cualquier lectura
  (`execute`, también el reintento de los abonos sin base de DX-380). La precarga no
  la lee (reintenta con su backoff) y un acierto la limpia.
- **Single-flight**: N peticiones simultáneas del mismo día hacen una sola
  llamada (y un solo guardado) y reciben la misma respuesta.
- **Presupuestos** de fallos de caché (llamadas reales, no peticiones), en
  ventana deslizante: por clínica `EXCHANGE_PROVIDER_CLINIC_LIMIT` en
  `EXCHANGE_PROVIDER_CLINIC_WINDOW_MS` (30 por hora) y global
  `EXCHANGE_PROVIDER_GLOBAL_LIMIT` en `EXCHANGE_PROVIDER_GLOBAL_WINDOW_MS`
  (250 por día, ~75 % de la cuota diaria prorrateada del plan «Developer»;
  ajústalo al plan contratado). Un aviso `exchange.provider_budget_half` sale
  al pasar la mitad del global y `exchange.provider_budget_exhausted` al
  agotar uno. Superado: `ExchangeRateBudgetExceededError` (para quien
  convierte por dentro es «sin tasa») y, en las rutas, **429
  `EXCHANGE_RATE_BUDGET_EXCEEDED`** con `Retry-After` y el mensaje en español.
  La precarga diaria (`prefetchProviderRates`) ni cuenta ni se corta: las
  peticiones de usuarios nunca la dejan sin cupo.
- **Límite**: la caché negativa, el single-flight y los presupuestos viven en
  memoria de cada réplica (como el rate limiting): con N réplicas el tope
  efectivo es N veces el configurado. No hay un contador compartido en la BD
  para esto; si se pasa a varias réplicas, divide los topes entre ellas.
- **Fuente manual**: una clínica en `MANUAL` nunca llama al proveedor por los
  días de su tasa manual (D >= `manualSince`). Un día anterior al cambio sin
  snapshot sí se pide, como en `AUTOMATIC` y con sus mismos topes: así un
  abono de ese día que quedó «sin tasa» al cambiar (BE-047) la congela en el
  barrido.
- **Proveedor**: `fetch` con `AbortSignal.timeout(10 s)`; los errores llevan
  el estado HTTP y el tipo de error, nunca el cuerpo de la respuesta. En las
  rutas, un día sin tasa del proveedor es **503 `EXCHANGE_RATE_UNAVAILABLE`**
  («No pudimos obtener las tasas de ese día. Inténtalo de nuevo más tarde.»),
  antes un 500 genérico.
- **Rate limit `exchange-rates`**: 120 peticiones por minuto por clínica +
  usuario, un balde para las dos rutas (`RATE_LIMIT_EXCHANGE_RATES_LIMIT`/`_TTL_MS`).
- **Pruebas**: `provider-rates-gate.spec.ts` (caché negativa con reloj fijo,
  single-flight, presupuestos), `get-rates-for-date.use-case.spec.ts`,
  `open-exchange-rates.provider.spec.ts`, `test/exchange-provider-quota.int-spec.ts`
  (ventana desde la BD y precarga con el global agotado) y
  `test/exchange-provider-quota.e2e-spec.ts` (50 días antiguos → 429 sin más
  llamadas al doble del proveedor).

## Tasa congelada en cada abono y aviso «sin tasa» (DX-375)

Porción 2 de DX-367. Cada abono guarda la tasa con la que se convirtió y su
fuente, y saldos y totales la usan siempre: cambiar la tasa (o la fuente)
después no altera nada ya calculado.

- **Cuándo se congela**: al registrar el abono (`RecordPaymentUseCase`),
  fuera de la transacción, con la fuente de la clínica y el **día civil del
  abono en su sede** (`paidOn`, DX-097): `ConvertAmountUseCase.quote` da las
  dos tasas por 1 USD tal como las dio la fuente, la fuente y el día. Dentro
  de la transacción del alta, con el plan bloqueado, se guarda si sigue
  valiendo: la misma moneda del plan, el mismo día y, con `MANUAL`, las mismas
  tasas manuales, que quedan `FOR SHARE` hasta el COMMIT. La base de
  imputación (DX-051) y el saldo del recibo salen de esa misma tasa, ya
  redondeada a los 8 decimales de la columna (lo mismo que se lee después;
  una tasa que redondea a 0 cuenta como «sin tasa»). Si dentro ya no vale, el
  abono queda «sin tasa» y el recibo sale sin saldo del plan.
- **Columnas** de `payments` (todas NULL): `exchangeRateCurrency` (moneda de
  destino: la del plan o la del saldo migrado; la escribe todo abono nuevo),
  `exchangeRateFrom` y `exchangeRateTo` (unidades de la moneda del abono y de
  la de destino por 1 USD, `Decimal(18,8)`), `exchangeRateSource` y
  `exchangeRateDate`. CHECK `payments_exchange_rate_check` (las cuatro de la
  tasa juntas, > 0 y solo con moneda distinta) y FK a `currencies`. Se guardan
  las dos tasas por 1 USD, no el cociente: convertir con ellas da lo mismo,
  céntimo a céntimo, que la conversión en vivo (`convertWithQuote`).
- **Estado** de cada abono (`exchangeRateStatus` en la respuesta):
  `NOT_NEEDED` (misma moneda), `FROZEN`, `MISSING` («sin tasa») y `LEGACY`
  (anterior a DX-375 en otra moneda, aún sin congelar).
- **Lectura** (`paymentAmountIn`, la única para saldo del plan, totales y
  dashboard, base de imputación y backfill): con tasa congelada, siempre con
  ella; `MISSING` no cuenta (`null`); `LEGACY` se convierte con la tasa de su
  día, como antes («lectura compatible»). `GET /treatment-plans/:id/balance`
  cuenta un abono con base de imputación **por su base** (BE-050: lo cobrado y
  el desglose por ítem salen de la misma cifra) y devuelve
  `paymentsWithoutRate` (`paymentId`, `amount`, `currency`, `paidOn`). El
  estado de cuenta y la caja no convierten (siguen por moneda).
- **Sin tasa del día**: el abono se guarda igual (201), sin base y con el
  recibo sin saldo; el saldo lo dice en `paymentsWithoutRate` y la web enseña
  el aviso con enlace a Ajustes › Tasa de cambio. El barrido de cada minuto
  (`payment-allocations.sweep`) congela primero la tasa de los abonos que la
  esperan y después crea sus bases, con el reintento escalonado de DX-380
  (sección siguiente): hasta 50 por clínica, el que venció antes primero.
- **Cambio de fuente** (BE-047): `PUT /exchange/settings`, si la fuente
  cambia, congela ANTES todos los abonos pendientes de la clínica con la
  fuente de antes (`ExchangeSourceChangeHooks`, que registra
  `PaymentAllocationJobs`). Un abono de hoy anterior al cambio, de una sede
  con otra zona o anterior a DX-375 conserva su tasa. Si congelar falla, la
  fuente no cambia. Los que siguen sin tasa la toman de la fuente nueva.
- **Tasa manual usada**: `PUT /exchange/manual-rates/:id` (`{ rate }`, solo
  ADMIN, `@Audit` UPDATE `EXCHANGE_RATE`) corrige una tasa que ningún abono
  congeló; una usada responde 409 `MANUAL_EXCHANGE_RATE_IN_USE` («Esta tasa ya
  la usa al menos un abono…»). La lista marca cada tasa con `inUse`. El
  repositorio la bloquea `FOR UPDATE` y comprueba el uso en la misma
  transacción; el trigger `manual_exchange_rates_in_use_guard` lo impide
  también en la BD (índice parcial `payments_exchange_rate_manual_idx`).
  Corregir una tasa usada, con motivo y rehaciendo la base, queda fuera.
- **Migraciones**: `20261102120000_dx375_payment_exchange_rate` (columnas,
  CHECK y FK NOT VALID, GRANT UPDATE de `rate`, trigger),
  `20261102120100_dx375_payment_exchange_rate_backfill` (relleno por lotes de
  2.000 por clínica con `lock_timeout`: `exchangeRateCurrency` de los abonos
  en la moneda de su destino), `20261102120200_…_pending_idx` y
  `20261102120300_…_manual_idx` (CONCURRENTLY, una por fichero) y
  `20261102120400_…_validate`. Los abonos anteriores en otra moneda no se
  rellenan en SQL (la tasa depende de la zona de la sede, la fuente y el
  proveedor, que viven en la API): se leen como antes y el barrido les congela
  esa misma tasa. Compatible hacia atrás: una réplica anterior no nombra las
  columnas nuevas y sus abonos nacen `LEGACY`.
- **Despliegue**: `npx prisma migrate deploy` antes de la primera réplica
  nueva; después, `npm run db:check-force`. El barrido termina de congelar los
  abonos anteriores solo (50 por clínica y minuto).
- **Demo**: `npm run seed:demo` deja un abono de hoy de 50 USD en el plan
  «Endodoncia y rehabilitación de 46» (en COP). Sin clave del proveedor queda
  «sin tasa» y enseña el aviso; para verlo congelado, pasa a `MANUAL` y
  registra la tasa COP de hoy: el barrido lo congela en menos de un minuto.

## Medios de pago de la clínica y referencia del pago (DX-377)

Porción 1. Cada clínica tiene su catálogo de medios de pago (`payment_methods`,
RLS FORCE, FK compuesta desde `payments`). Un medio tiene nombre libre, tipo
base (`CASH`, `CARD`, `TRANSFER`, `DIGITAL`, `OTHER`), activo y «pide
referencia». No se borra: se desactiva (la app no tiene DELETE).

- **Endpoints**: `GET /payment-methods` (roles de cobro; solo activos, o
  `?includeInactive=true`), `POST /payment-methods` y
  `PATCH /payment-methods/:id` (solo ADMIN; 403 «Solo un administrador puede
  gestionar los medios de pago.»; 409 con nombre repetido, sin distinguir
  mayúsculas). Auditados como `PAYMENT_METHOD`.
- **Abono** (`POST /treatment-plans/:id/payments` y
  `POST /opening-balances/:id/payments`): `paymentMethodId` (activo y de la
  clínica, si no 400), `reference` (1-60; obligatoria si el medio la pide, 400
  en español) y `duplicateReferenceReason`. La referencia se guarda tal cual y
  normalizada (`referenceNormalized`: sin espacios y en mayúsculas).
- **Referencia repetida**: si el mismo medio y la misma referencia normalizada
  están en un abono vivo de la clínica con `paidAt` a ±90 días, la API responde
  **409 `code: PAYMENT_REFERENCE_DUPLICATE`** con `matches` (id, fecha, importe,
  moneda, nº de recibo). Se confirma repitiendo la petición con
  `duplicateReferenceReason` (1-300). El motivo queda en el abono; la auditoría
  guarda `metadata.paymentReference` (`duplicateConfirmed` y los ids
  repetidos), nunca la referencia ni el motivo. Índice
  `payments_tenant_method_reference_idx (tenantId, paymentMethodId,
  referenceNormalized, paidAt)`. Es un aviso: se comprueba fuera de la
  transacción del alta.
- **Método antiguo**: `payments.method` se sigue escribiendo, derivado del tipo
  base (**`DIGITAL` → `TRANSFER`**: se concilia contra el extracto como una
  transferencia). Un cliente o réplica que solo manda `method` queda enlazado al
  medio inicial de ese método.
- **Relleno** (`20261103120100_dx377_payment_methods_backfill`): cada clínica
  recibe los 4 medios iniciales (Efectivo, Tarjeta, Transferencia, Otro; activos
  y sin pedir referencia, `legacyMethod` = su método) y cada abono con `method`
  se enlaza al de su clínica, por lotes e idempotente. Las clínicas nuevas los
  reciben en el alta. La FK `payments_payment_method_fkey` se queda NOT VALID a
  propósito (DX-134), como la de DX-375.
- **Caja y recibo**: cada fila de `GET /payments` trae `paymentMethod` y
  `reference`, y `summary.byPaymentMethod` totaliza por medio y moneda (un
  abono sin medio de una réplica anterior cuenta en el medio inicial de su
  método). El recibo lleva `paymentMethodName` y `reference`.

## Medio y referencia en el estado de cuenta y filtro de caja por medio (DX-395)

Seguimiento de DX-377.

- **Estado de cuenta** (`GET /patients/:id/account-statement`, solo roles de
  cobro): cada movimiento trae `paymentMethod` (`{ id, name }` del medio de la
  clínica; el inicial de su método si lo registró una réplica anterior sin
  medio) y `reference`. `method` sigue siendo el método antiguo (un medio
  digital es `TRANSFER`): para mostrar, `paymentMethod.name`.
- **Caja por medio**: `GET /payments?paymentMethodId=` filtra por cualquier
  medio de la clínica, también los propios y los desactivados. Uno inicial
  cuenta además los abonos sin medio de su método. El medio se lee bajo RLS:
  de otra clínica o inexistente, 400 «Medio de pago no encontrado en esta
  clínica.».
- **CSV de la caja**: `GET /payments.csv` (mismos roles, sede y filtros que
  la caja, sin paginar, hasta 10 000 abonos; auditado como `EXPORT` de
  `PAYMENT`). Columnas: Fecha, Sede, Paciente, Destino, Medio, Referencia,
  Moneda, Importe. Las notas del abono no viajan.
- **Referencia normalizada**: sin espacios (también los duros), puntos ni
  guiones (también los tipográficos U+2010-U+2015 y el signo menos) y en
  mayúsculas: «123-456», «123.456» y «123 456» son la misma. Una referencia
  de solo separadores no cuenta como referencia.
- **Mensajes**: una referencia de más de 60 caracteres o un motivo de más de
  300 responden 400 en español desde el DTO.
- **Migración** `20261103130000_dx395_payments_relink_reference` (datos, por
  lotes de 2.000, clínica a clínica, idempotente): repite el enlace de los
  abonos sin `paymentMethodId` al medio inicial de su método (los que
  cobraron las réplicas anteriores durante el despliegue de DX-377) y quita
  puntos y guiones de `referenceNormalized` de las referencias guardadas.
  Desplegarla cuando ya no quede ninguna réplica anterior a DX-377; si se
  despliega antes, basta con repetirla (`prisma migrate resolve
  --rolled-back 20261103130000_dx395_payments_relink_reference` y `deploy`).

## Tipos de documento genéricos y nombres locales (DX-327)

El tipo de documento de un paciente o de un contacto es uno de cinco, iguales
para cualquier clínica y país: `NATIONAL_ID` («Documento nacional»),
`PASSPORT` («Pasaporte»), `RESIDENCE_PERMIT` («Permiso de residencia»),
`TAX_ID` («Identificación fiscal») y `OTHER` («Otro documento»). Ningún código
nombra el documento de un país. Los códigos anteriores a DX-327 solo se
traducen en `src/modules/patients/domain/legacy-doc-type.ts` (excepción G5.3),
y la guarda `src/architecture/no-location-fallbacks.spec.ts` lo comprueba,
también sobre este README. Migraciones
`20261030120000_dx327_document_type`,
`20261030120100_dx327_document_type_backfill`,
`20261030120200_dx327_document_type_validate` y
`20261030120300_dx327_tenant_document_type_names`.

- **Pacientes y contactos**: `docType` (uno de los cinco; el alta lo exige y
  no propone ninguno), `docTypeLabel` y `docTypeName`.
  - `docTypeLabel` es el nombre libre del documento de ese paciente. Es
    opcional, de 1 a 40 caracteres, se recorta y vacío es `null`. Un cambio de
    tipo que no trae etiqueta la deja en `null`; con el mismo tipo, se queda.
  - `docTypeName` es el nombre visible, que resuelve la API: la etiqueta del
    paciente; si no, el nombre local de la clínica para su tipo; si no, el
    genérico. Es el que imprimen las recetas, consentimientos, presupuestos,
    recibos, tarjetas de implante y el estado de cuenta nuevos. Lo ya emitido
    conserva su texto y su hash.
  - Durante la fase 1, los cuerpos de alta y edición (pacientes, contactos y
    el `defaultDocType` de la importación) aceptan también los códigos
    anteriores, para la web anterior. Se traducen a su genérico, sin etiqueta.
    OpenAPI publica solo los cinco genéricos.
- **Nombres locales de la clínica**: `tenants."docTypeNameNationalId"`,
  `…Passport`, `…ResidencePermit`, `…TaxId` y `…Other`, todos nullable y
  sin relleno. Todas las clínicas, también las nuevas y la demo, empiezan sin
  ninguno (se ve el genérico).
- **Endpoints** (declarados antes de `GET /patients/:id`):
  - `GET /patients/document-type-names` (los 4 roles) devuelve
    `{ names: { NATIONAL_ID, PASSPORT, RESIDENCE_PERMIT, TAX_ID, OTHER } }`,
    cada uno texto o `null`.
  - `PUT /patients/document-type-names` solo lo usa el ADMIN
    (`CLINIC_SETTINGS_WRITE_ROLES`). Cualquier otro rol recibe 403 «Solo un
    administrador puede cambiar los nombres de los documentos.».
  - El cuerpo es el mismo `{ names }` y sustituye los cinco: una clave ausente
    o `null` queda sin nombre local. Cada nombre se recorta, admite hasta 60
    caracteres y necesita al menos una letra o un número.
  - Dos tipos no pueden compartir nombre, y un nombre no puede ser el código
    ni el nombre genérico de otro tipo. Se compara sin mayúsculas, tildes
    latinas ni puntuación, en cualquier escritura.
  - Si no se cumple, la respuesta es 400 y no se guarda nada. Los mensajes
    son:
    - «“…” ya es el nombre de … Cada tipo necesita un nombre distinto.»;
    - «“…” es el nombre de … Elige otro.»;
    - «El nombre necesita al menos una letra o un número.»;
    - «El nombre del documento admite hasta 60 caracteres.».
  - Un cuerpo sin `names`, o con un valor que no es texto, también es 400.
  - Cambiar un nombre no toca ningún paciente.
- **Escritura**: lee la fila de la clínica con `FOR UPDATE` y escribe los
  cinco en un solo `UPDATE` de la misma transacción.
- **Auditoría**: solo si cambia algún nombre. Es un UPDATE de
  `CLINIC_SETTINGS` sin recurso ni paciente, con
  `reason: DOCUMENT_TYPE_NAMES_SETTINGS` y `changedFields` con los tipos que
  cambiaron (nunca los textos). Guardar lo mismo responde 200 sin evento.
- **Importación**: la columna de tipo reconoce, en este orden, los nombres
  locales de la clínica, los códigos y nombres genéricos, y los sinónimos de
  los archivos de siempre. Dos filas con el mismo número y el mismo tipo
  genérico son el mismo paciente. Ver «Importación de pacientes» abajo.
- **BD**: `patients."documentType"` (con `DEFAULT 'OTHER'`) y
  `"docTypeLabel"`, y lo mismo, nullable, en `patient_responsible_parties`.
  Durante la fase 1 se queda la columna anterior `"docType"`, para las réplicas
  anteriores. La API la escribe solo al crear, y el trigger
  `dx_document_type_sync` mantiene coherentes las dos columnas. El trigger
  nunca escribe una etiqueta: solo la conserva o la pone a `NULL`.
- **Despliegue** (orden obligatorio):
  1. **Antes de `migrate deploy`**, en cada entorno, se ejecuta la consulta
     previa (solo lectura) y se guarda en la nota de versión. Hace falta un
     rol con `BYPASSRLS` (el del DBA); con el owner `NOBYPASSRLS` devuelve 0
     filas.

     ```sql
     -- 1. Tipos guardados (después deben cuadrar con su genérico).
     SELECT 'patients' AS tabla, "docType"::text AS tipo, ("deletedAt" IS NULL) AS vivo, count(*)
       FROM "patients" GROUP BY 1, 2, 3
     UNION ALL
     SELECT 'responsables', coalesce("docType"::text, '—'), ("deletedAt" IS NULL), count(*)
       FROM "patient_responsible_parties" GROUP BY 1, 2, 3
     ORDER BY 1, 2, 3;
     -- 2. Claves con más de un paciente vivo (DX-287): el número no debe cambiar.
     SELECT count(*) AS claves_ambiguas, coalesce(sum(n), 0) AS pacientes
       FROM (SELECT count(*) AS n FROM "patients"
              WHERE "deletedAt" IS NULL AND "docNumber" IS NOT NULL
              GROUP BY "tenantId", "docKey" HAVING count(*) > 1) s;
     -- 3. De ellas, las que mezclan códigos anteriores distintos. Las que
     --    mezclan los dos que pasan a NATIONAL_ID dejan de ser «otro tipo».
     SELECT count(*) AS claves_con_codigos_distintos
       FROM (SELECT 1 FROM "patients"
              WHERE "deletedAt" IS NULL AND "docNumber" IS NOT NULL
              GROUP BY "tenantId", "docKey"
             HAVING count(DISTINCT "docType") > 1) s;
     -- 4. Filas de importación pendientes con su código (se traducen al leerlas).
     SELECT "data"->>'docType' AS tipo, count(*) FROM "patient_import_rows"
      WHERE "outcome" = 'PENDING' AND "data" IS NOT NULL GROUP BY 1;
     ```

  2. `npx prisma migrate deploy` aplica las cuatro y tiene que terminar ANTES
     de que arranque la primera réplica nueva, sea de la API (`APP_ROLE=api`)
     o del worker (`APP_ROLE=worker`). Una réplica nueva contra el esquema
     anterior da 500 en casi todo DTO de paciente, porque resuelve
     `docTypeName`. Las réplicas anteriores siguen funcionando con el esquema
     nuevo.
     - **M1** (`…120000`) añade las columnas, las funciones, los CHECK
       `NOT VALID` y los triggers en una transacción. Toma un
       `ACCESS EXCLUSIVE` breve sobre `patients` y
       `patient_responsible_parties`, sin leer la tabla (`lock_timeout` 5 s).
     - **M2** (`…120100`) rellena `"documentType"` por clínica, en lotes de
       2.000 con `COMMIT` por lote (`lock_timeout` 5 s por lote, sin quitar
       FORCE). No escribe ninguna etiqueta. Es idempotente.
     - **M3** (`…120200`) valida los tres CHECK (`SHARE UPDATE EXCLUSIVE`, no
       frena escrituras). Falla con `RAISE EXCEPTION` si queda una fila con
       la pareja de tipos incoherente o con etiqueta.
     - **M4** (`…120300`) añade los cinco nombres a `tenants`, con sus CHECK.
       Toma un `ACCESS EXCLUSIVE` breve sobre `tenants`, que casi toda
       petición lee; mientras espera su bloqueo (hasta 5 s), esas peticiones
       hacen cola. Hay que desplegar a una hora de poco tráfico.
  3. Si M1, M2 o M4 fallan (por `lock_timeout`, o porque se cortó el
     relleno), se ejecuta
     `npx prisma migrate resolve --rolled-back <migración>` (la que nombre
     `npx prisma migrate status`) y se repite `migrate deploy`. Si una
     migración figura fallida pero su efecto ya está (las columnas en
     `information_schema`, o el CHECK validado en `pg_constraint`), se usa
     `--applied` en lugar de `--rolled-back`.
  4. Si M3 falla por una fila incoherente, se para el despliegue y NO se
     despliega la API ni el worker: se investiga con la consulta posterior
     (paso 5).
     - Si M3 falló y la API nueva se desplegó igualmente, en cuanto alguien
       guarda un «Nombre del documento» ningún reintento de M3 puede pasar.
       En ese caso no se repite M3 ni se borran etiquetas.
     - Primero se comprueba, con un rol `BYPASSRLS`, que
       `SELECT conname, convalidated FROM pg_constraint WHERE conname IN
       ('patients_doc_type_label_check',
       'patient_responsible_parties_doc_type_label_check',
       'patient_responsible_parties_document_type_check')` da los tres
       `true`. Si alguno sale `false`, se valida a mano con
       `ALTER TABLE … VALIDATE CONSTRAINT …`.
     - Después, `SELECT count(*) FROM "patients" WHERE NOT
       dx_doc_type_coherent("docType", "documentType")`, y lo mismo en
       `patient_responsible_parties`, tienen que dar 0.
     - Solo entonces se ejecuta
       `npx prisma migrate resolve --applied 20261030120200_dx327_document_type_validate`.
  5. **Después**, la consulta posterior:
     `SELECT "docType"::text, "documentType"::text, "docTypeLabel", count(*) FROM "patients" GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`.
     Cada código anterior tiene que salir con su genérico y **todas** las
     filas con `"docTypeLabel"` NULL. La consulta previa 2, repetida, tiene
     que dar lo mismo.
  6. Se despliegan la API **y los workers** de forma gradual hasta el 100 %.
     Solo entonces se despliega la web, sin demora. Mientras tanto (el
     hueco):
     - la web anterior pinta «undefined» delante del número;
     - un presupuesto mostrado por una versión y aceptado en la otra da 409
       una vez («El presupuesto cambió desde que se mostró…»); se recarga y
       se firma;
     - un worker anterior que procesa con «actualizar vacíos» una fila que la
       API nueva dio por «ya existe» la deja `SKIPPED` en lugar de `FILLED` si
       el paciente guardaba el otro código anterior del documento nacional.
       No se corrompe nada, y se puede repetir la importación con la versión
       nueva.
- **Vuelta atrás**: primero la web, después la API y los workers. Es inocua:
  - el trigger mantiene al día la columna anterior;
  - la API anterior no selecciona las columnas nuevas (tampoco las de
    `tenants`);
  - las etiquetas y los nombres locales no se ven, pero no se pierden; solo
    se borra una etiqueta si alguien cambia el tipo genérico.

  Un `TAX_ID` se ve como «Documento …» en la web anterior. No se revierte
  ninguna migración. Al volver a la versión nueva, todo está coherente.
- **Fase 2** (ticket aparte, con 0 réplicas y 0 workers anteriores):
  - se quitan la columna anterior, el trigger, las funciones y el enum
    `DocType`;
  - antes de borrar la columna, hay que recrear
    `patient_responsible_parties_kind_check` sin ella, porque `DROP COLUMN`
    borra en silencio todo CHECK que la nombra;
  - la traducción de solo lectura de los códigos anteriores no se borra
    nunca: las fotos de recibos y las filas de importación antiguas la
    necesitan.

## País de la sede ISO 3166 (DX-312)

El país de una sede es cualquier código ISO 3166-1 alfa-2 de la tabla
`countries`. Ninguna regla lo lee. La moneda, lo único que puede ir ligado a
un país, es un campo propio de la sede (G1) y no se deduce de él. Tampoco el
prefijo telefónico: desde DX-329 es la región telefónica de la sede, que el
país solo sugiere al crearla (ver «Teléfonos con libphonenumber-js»). Es la
fase 1 de un cambio sin parada (expand/contract).

- **Modelo**:
  - `locations."countryCode"` (`CHAR(2)`, `NOT NULL`, sin default), con la
    FK `locations_country_code_fkey` a `countries.code` (`ON DELETE
    RESTRICT`, `ON UPDATE CASCADE`). En Prisma y en el contrato HTTP el
    campo se sigue llamando `country` (`@map("countryCode")`);
  - `pending_registrations."locationCountryCode"`, igual pero nullable;
  - `countries`: 250 filas (los 249 códigos ISO asignados más `XK`) con el
    nombre en español de CLDR. La lista sale de
    `prisma/scripts/generate-iso3166.ts`, que escribe
    `prisma/reference/iso3166.ts` y `prisma/reference/iso3166-countries.json`
    (la web lo copia byte a byte; lo comprueba
    `scripts/check-api-reference-sync.mjs`). M1 la siembra y `seed.ts` la
    repite. Cambiar la lista es regenerar, revisar el diff y crear una
    migración nueva con el mismo `INSERT … ON CONFLICT DO UPDATE`.
- **Validación** (`validateCountry`, `regional-settings.ts`): el código se
  recorta y se pasa a mayúsculas. Sin país, con un código que no tiene dos
  letras o que no está en `countries`, la respuesta es 400 con
  `field: country` (alta y edición de sede) o `field: locationCountry`
  (registro). En la edición, un `country` ausente no cambia nada; `null` o
  vacío es 400.
- **Lo guardado no se reescribe**: cambiar el país de una sede no toca
  teléfonos, recetas ni nada guardado, ni la región telefónica de la sede.
- **Registro**: el cuerpo sin campos de sede (la forma legada, anterior a G1)
  es 400 con `field: locationCountry`. Un pendiente legado (sin sede) da 410
  `REGISTRATION_LINK_EXPIRED` en `verify` y no se consume.
- **Columnas legadas de la fase 1** (excepción G5.3, DX-334): se quedan
  `locations."country"` y `pending_registrations."locationCountry"` (enum
  `ClinicCountry`, ahora nullable) para las réplicas anteriores. Las mantienen
  los triggers `locations_country_code` y
  `pending_registrations_location_country_code`, con la proyección
  `dx_legacy_clinic_country(code)`: el mismo valor si es uno de los dos del
  enum y `NULL` en cualquier otro país. El cliente nuevo no las lee ni las
  escribe (`@ignore`). En el código, el enum solo se nombra en
  `src/shared/locations/legacy-clinic-country.ts`.
  - **Paso 0 del trigger**: un INSERT de sede sin `"countryCode"` y sin
    moneda, zona, formato ni revisión (la forma exacta del registro legado de
    la API anterior) se rechaza con `check_violation`. Así una réplica
    anterior no puede crear una clínica con el país que su cliente de Prisma
    pone por defecto.
  - `prescriptions.country` pasa a nullable. El CHECK
    `prescriptions_legacy_country_present_check` exige país en las recetas
    legadas; la receta única guarda la proyección (o `NULL`) y nada decide
    con ella. DX-364 deja de escribirlo.
- **Guardas**: `src/architecture/no-location-fallbacks.spec.ts`, bloque
  «país de la sede libre (DX-312)». Ningún fichero de producción de `src/`
  compara el país con un literal o una constante en MAYÚSCULAS, hace `switch`
  con un `case` de dos letras, lo busca en una lista, tabla, `Set`,
  `Object.hasOwn` o expresión regular, ni indexa un objeto por códigos de
  país. Sus límites conocidos están en la cabecera del bloque.

**Migraciones** (todas con `SET LOCAL lock_timeout = '5s'`):

| Migración | Qué hace | Bloqueo | A mano |
|---|---|---|---|
| M1 `20261031120000_dx312_location_country_code` | Siembra `countries` (upsert, antes de los bloqueos); columnas nuevas, FK `NOT VALID`, funciones y triggers; `DROP NOT NULL` de las columnas legadas y CHECK de recetas `NOT VALID`. Sin relleno | `ACCESS EXCLUSIVE` breve en `locations`, `pending_registrations` y `prescriptions`, sin recorrer | `psql -1` |
| M2 `20261031120100_dx312_location_country_code_backfill` | Rellena `"countryCode"` clínica por clínica, con `COMMIT` por clínica, y los pendientes. Idempotente | de fila | **sin** `-1` |
| M3 `20261031120200_dx312_location_country_code_validate` | Valida la FK de pendientes y el CHECK de recetas; comprobación por clínica (falla con `RAISE EXCEPTION` si una sede no tiene país, tiene un código fuera de `countries` o la pareja es incoherente); después el bracket `NO FORCE` → `VALIDATE` de la FK de `locations` → `FORCE`, y el `NOT NULL` vía un CHECK validado | `ACCESS EXCLUSIVE` en `locations` **desde su `NO FORCE` hasta el `COMMIT`** | `psql -1` |
| M4 `20261031120300_dx312_location_country_drop_default` | `ALTER COLUMN "country" DROP DEFAULT` en `locations` | `ACCESS EXCLUSIVE` breve | `psql -1` |

- `prisma migrate deploy` aplica cada una en su transacción. **A mano**
  (ensayo, sonda, operación): M1, M3 y M4 con
  `psql -1 -v ON_ERROR_STOP=1 -f …/migration.sql`. Sin `-1`, un fallo de M3
  después de su `NO FORCE` dejaría `locations` sin FORCE RLS, y
  `SET LOCAL lock_timeout` no haría nada; el int
  `test/location-country-code-migration.int-spec.ts` comprueba que, con `-1`,
  un fallo del `VALIDATE` dentro del bracket lo deshace todo y FORCE sigue
  puesto. M2 va **sin** `-1`: sus `COMMIT` dentro del `DO` fallan en un
  bloque de transacción («invalid transaction termination»).
- `locations` se lee en casi cada petición: todo en horas de poco tráfico.
- Si una falla por `lock_timeout`: `npx prisma migrate resolve --rolled-back
  <migración>` y repetir. Si M2 se corta, lo mismo (es idempotente). Si una
  figura fallida pero su efecto ya está, `migrate resolve --applied`: M3 si
  `"countryCode"` tiene `is_nullable = 'NO'` en
  `information_schema.columns`; M4 si `column_default` de
  `locations.country` es NULL.
- Si M3 falla por la comprobación por clínica, no se despliega la API: se
  investiga con la consulta posterior.

**Runbook (en este orden):**

1. Merge de la API antes que el de la web.
2. Antes de `migrate deploy`, con un rol `BYPASSRLS` y solo lectura, la
   consulta previa (a la nota de versión). La 2 tiene que dar 0; si no, se
   espera a que caduquen (24 h). El 100 % de la API y de los workers tiene
   que estar en DX-327 o posterior.

   ```sql
   -- 1. Países de las sedes (después deben cuadrar 1:1 con "countryCode").
   SELECT "country"::text AS pais, ("deletedAt" IS NULL) AS viva, count(*) FROM "locations" GROUP BY 1, 2 ORDER BY 1, 2;
   -- 2. Pendientes vivos sin sede (forma legada): debe ser 0.
   SELECT count(*) FROM "pending_registrations" WHERE "expiresAt" > now() AND "locationCountry" IS NULL;
   -- 3. Recetas por país y formato (no deben cambiar).
   SELECT "country"::text, "singleFormat", count(*) FROM "prescriptions" GROUP BY 1, 2 ORDER BY 1, 2;
   -- 4. Países sembrados.
   SELECT count(*) FROM "countries";
   ```
3. `prisma migrate deploy` (M1-M4) termina **antes** del despliegue gradual.
4. Consulta posterior: `SELECT "country"::text, "countryCode", count(*) FROM
   "locations" GROUP BY 1, 2` solo da parejas iguales; `countries` tiene 250
   filas (o más, si la base tenía propias); las consultas 1 y 3 dan lo mismo.
   Y la consulta P5 (solo lectura, `BEGIN READ ONLY`, rol `BYPASSRLS`; lee
   `"countryCode"`, así que va tras `migrate deploy` y antes de la web): qué
   clínicas tienen sedes de qué país, para comprobar que ninguna del piloto
   quedó con un país que no es el suyo. Si alguna lo está, la corrige su
   ADMIN; nada se reescribe solo.

   ```sql
   SELECT t."subdomain", t."name" AS clinica, l."countryCode" AS pais,
          count(*) FILTER (WHERE l."deletedAt" IS NULL) AS sedes_vivas,
          count(*) FILTER (WHERE l."deletedAt" IS NOT NULL) AS sedes_borradas
   FROM "locations" l JOIN "tenants" t ON t."id" = l."tenantId"
   GROUP BY 1, 2, 3 ORDER BY 1, 3;
   ```
5. La API **y los workers** hasta el 100 %. **Solo entonces, la web**: es la
   única que ofrece países fuera de los dos del enum, así que mientras viva
   una réplica anterior no existe ninguna sede, receta ni pendiente de otro
   país (salvo una llamada directa a la API nueva).

**Réplica anterior contra la BD migrada** (ensayo de DX-312 con la API
anterior entera):

- Lee y escribe igual que hoy en las clínicas cuyas sedes son de los dos
  países del enum. Sus escrituras mandan la columna legada y el trigger
  rellena `"countryCode"`.
- Una clínica con alguna sede (o receta) de otro país tiene la columna legada
  a `NULL`, que su Prisma no admite: **500 solo en esa clínica y solo en las
  lecturas autenticadas** que leen la sede (`GET /locations`, recetas, emisor,
  bloque de comunicaciones con esa sede) y al **crear** enlaces
  (anamnesis, postoperatorio) en esa sede. Las demás clínicas no se enteran
  (RLS por clínica). Los **enlaces públicos ya emitidos se siguen abriendo**
  (la anamnesis pública solo lee el id y el nombre de la sede), y también la
  marca pública de la clínica. La baja por respuesta de WhatsApp solo falla
  si la sede principal de la clínica es de otro país. Nunca se escribe un
  país equivocado.
- Un pendiente legado, o uno de otro país creado por la API nueva, que
  confirma (`verify`) una réplica anterior: el paso 0 del trigger rechaza la
  sede y la transacción del alta se deshace entera. La respuesta es un **400
  genérico** (`CHECK_VIOLATION`, SQLSTATE 23514; su log dice solo «Regla de
  BD violada (23514): -»), **no un 500**, y **no se crea nada**: ni clínica,
  ni usuario, ni sede. El pendiente queda consumido; la persona se registra
  de nuevo.
- Un `PATCH` de la API anterior que mande `country` de uno de los dos
  valores del enum sobre una sede de otro país cambia la columna legada y el
  trigger pone `"countryCode"` a ese valor. Es una elección explícita de quien
  llama, nunca un valor por defecto, y la web anterior no llega a esa clínica
  (500).

**Vuelta atrás**: primero la web, después la API y los workers. Antes de
volver a la API anterior, con un rol `BYPASSRLS`:

```sql
SELECT (SELECT count(*) FROM "locations" WHERE "country" IS NULL) AS sedes,
       (SELECT count(*) FROM "prescriptions" WHERE "country" IS NULL) AS recetas,
       (SELECT count(*) FROM "pending_registrations"
         WHERE "expiresAt" > now() AND "locationCountry" IS NULL) AS pendientes;
```

- **Las tres a 0**: el rollback es inocuo; el trigger mantiene al día la
  columna legada y la API anterior ignora las nuevas.
- **Alguna mayor que 0**: esas clínicas tendrían los 500 de arriba y esos
  pendientes no crearían clínica. **Se sigue hacia delante.** Nunca se
  escribe un país del enum en esas filas para poder volver: sería inventar un
  país.
- El trigger (con su paso 0) y M4 no se deshacen: la API anterior no
  necesita el default (su cliente manda el país).
- Un `prisma db seed` de la versión anterior (lo hace la CI) vuelve a poner
  los nombres de `countries` en inglés; producción no ejecuta el seed, y el
  `seed.ts` nuevo los deja otra vez en español.

**Fase 2** (ticket aparte bajo DX-311, «G1.1 · Fase 2: fuera
`ClinicCountry`»):

- **Requisitos (todos):**
  - 0 réplicas y 0 workers anteriores a DX-312, y 0 réplicas anteriores a
    DX-326 (por `payers.country`);
  - DX-364 publicado: la receta única ya no escribe `country` y el emisor no
    tiene `phase1`;
  - DX-351 publicado, porque borra `dx_g1_backfill_location_regional`, que
    lee `locations."country"`; si no, esta migración la borra antes del
    `DROP COLUMN`;
  - `SELECT count(*) FROM pending_registrations WHERE "expiresAt" > now() AND
    "locationCountryCode" IS NULL` = 0.
- **Migración** (`lock_timeout`, una transacción, `psql -1` a mano):
  - `DROP TRIGGER "locations_country_code" ON "locations"` y
    `DROP TRIGGER "pending_registrations_location_country_code" ON
    "pending_registrations"`;
  - `DROP FUNCTION` de `dx_location_country_code_sync()`,
    `dx_pending_registration_country_code_sync()` y
    `dx_legacy_clinic_country(text)`;
  - `DROP COLUMN` de `locations."country"`,
    `pending_registrations."locationCountry"` y `payers."country"`
    (DX-326);
  - `ALTER TYPE "ClinicCountry" RENAME TO "LegacyPrescriptionCountry"` (solo
    catálogo, sin reescribir `prescriptions`);
  - se quedan `prescriptions.country` (nullable) y
    `prescriptions_legacy_country_present_check`.
- **Código:** fuera los tres campos `@ignore` (`Location.legacyCountry`,
  `PendingRegistration.legacyLocationCountry`, `Payer.country`),
  `legacy-clinic-country.ts` y su spec; `Prescription.country` pasa a
  `LegacyPrescriptionCountry?`; la guarda «solo `legacy-clinic-country.ts`
  nombra `ClinicCountry`» pasa a «`ClinicCountry` no existe ni en el esquema
  ni en `src`».
- **Tests:** los casos del trigger del int pasan a «no queda trigger ni
  columna legada».
- Tras la fase 2, ninguna sede, pendiente ni pagador tiene un enum de país.
  Los dos valores solo sobreviven en `prescriptions.country`, como plantilla
  congelada de las recetas legadas (excepción permanente de DX-324).

## Teléfonos con libphonenumber-js (DX-329)

Los teléfonos los lee `libphonenumber-js` (`1.13.15`, build `max`), y solo a
través de `src/shared/phone/phone-number.ts`, el único fichero de `src/` que
la importa (lo comprueba `src/architecture/no-location-fallbacks.spec.ts`).
La librería decide qué es válido y qué es móvil. No queda ninguna tabla de
indicativos ni regla por país: el producto es mundial y nada se decide por
país.

- **Región telefónica de la sede** (`locations."defaultPhoneRegion"`,
  `CHAR(2)`, nullable y **sin default** en la BD, la API ni la web): la región
  de la librería (ISO 3166-1 alfa-2, más `AC` y `TA`) cuyo prefijo se añade a
  un número escrito sin `+`. `null` es «sin prefijo por defecto»: el número se
  escribe con `+`, y nunca se adivina el indicativo.
  - Al **crear** una sede (alta o registro, también la demo) sin el campo, la
    API guarda la sugerencia `suggestedPhoneRegion(país)`: el propio país si
    la librería lo admite, y si no, `null`. Es la única función que lee un
    país para algo del teléfono, y es la identidad.
  - En la **edición**, cambiar el país no toca la región. Con el campo
    presente (también `null`), se guarda lo que llega: dos letras de
    `phoneRegions()` o 400 con `field: 'defaultPhoneRegion'`. Lo que no es
    texto (un número, un objeto) da el mismo 400 con `field`, en el alta y en
    la edición.
  - `locations."defaultPhoneRegionSetAt"` (marca, sin default ni contrato):
    la API la escribe cada vez que escribe la región. Ningún relleno toca una
    sede con marca, así que nunca pisa una región que un ADMIN vació a
    propósito.
  - Una región guardada que la versión instalada no admite se lee como
    `null`: todas las lecturas pasan por `phoneRegionOrNull`. El relleno M2
    copia el país aunque la librería no lo numere (`AQ`, `BV`, `GS`, `HM`,
    `PN`, `TF`, `UM`), mientras que una sede nueva de esos países se crea con
    `null`. Las dos se comportan igual, como «sin prefijo». La migración
    aplicada no se cambia; la consulta para contarlas va en la nota de
    versión:
    ```sql
    SELECT "defaultPhoneRegion", count(*) FROM "locations"
     WHERE "deletedAt" IS NULL
       AND "defaultPhoneRegion" IN ('AQ','BV','GS','HM','PN','TF','UM')
     GROUP BY 1;
    ```
- **Lecturas**: un número es `VALID` (E.164, tipo, formato internacional,
  extensión), `AMBIGUOUS` (con `00` o con el indicativo escrito sin `+`, dos
  lecturas válidas y distintas: no se adivina, la ficha pide escribirlo con
  `+`) o `NONE`. El canal WhatsApp, el opt-in y los huecos exigen móvil; los
  enlaces `wa.me` aceptan cualquier número válido; la baja por «BAJA» casa
  cualquier número que se pueda leer. Los `wa.me` de la confirmación de cita,
  la cartera y los planes usan la región de la sede del recurso, no el país
  de la dirección del paciente.
- **Clínicas con sedes de regiones distintas**: un número guardado sin `+`
  se lee con la región de cada sede candidata: la del recurso en los `wa.me`
  y todas las sedes vivas en la baja por mensaje. «Nunca el número de otra
  persona» vale **por región**: unos mismos dígitos pueden ser un móvil
  válido en dos regiones (p. ej. un número nacional de una sede que en la
  otra se lee como móvil de allí). En esas clínicas conviene guardar los
  números con `+`; el informe las marca con `multiRegion: true`. Riesgo
  residual aceptado en la baja: el remitente tiene que compartir los 8
  últimos dígitos y escribir al número de la clínica, y lo peor que pasa es
  una baja de recordatorios, que es reversible, queda auditada y tiene el
  tope `REMINDER_OPT_OUT_MESSAGE_MAX_MATCHES`. DX-224 (E.164 congelado con
  la región en la que se escribió) lo cierra.
- **Baja por mensaje con una sede sin región** (vaciada por un ADMIN o
  creada por una réplica anterior al relleno): para casar la baja, y solo
  para eso, esa sede aporta `suggestedPhoneRegion(país)`. Darse de baja nunca
  es más difícil que antes de DX-329. Guardar un número y los `wa.me` siguen
  sin prefijo.
- **Formato internacional en las salidas** (DX-387): los pacientes (ficha,
  `GET /patients`, la lista de retención, alta y edición), los responsables
  (y el resumen de un paciente responsable) y las sedes devuelven, junto a
  `phone`, `phoneInternational`: el formato internacional del adaptador
  (`phoneInternational(texto, región)`), o `null` si no hay teléfono o no se
  lee de una sola forma; la web muestra `phoneInternational ?? phone`. Los
  pacientes y responsables se leen con la región de la sede activa o la
  principal (`DefaultPhoneRegionReader`, la misma lectura que el bloque de
  comunicaciones), una sola vez por petición y nunca por fila; cada sede, con
  la suya, que ya viene en la fila. El personal no tiene teléfono. El campo
  no se guarda ni se registra en ningún log.
- **Plantilla de importación**: las celdas de teléfono van vacías (DX-368).
  Un móvil de ejemplo válido de la región de la sede se importaría si nadie
  borra la fila de ejemplo y podría ser el número de una persona real; el
  formato lo explica la ayuda («con + y su prefijo»).
- **Lista de regiones**: `prisma/scripts/generate-phone-regions.ts` escribe
  `prisma/reference/phone-regions.ts` y `phone-regions-list.json` (nombres de
  CLDR). La web la copia byte a byte (`check-api-reference-sync.mjs`). El
  unit `phone regions match the installed libphonenumber-js` falla si la
  librería cambia y la lista no se regenera.
- **Política de actualización de la librería** (D4): la versión va
  **exacta**, sin `^`, porque `isValid()` y `getType()` dependen de los
  metadatos de cada versión. Subirla es un PR propio que regenera
  `phone-regions` (con Node 22.16), pasa el sync de la web y corre la suite
  de teléfonos (unit, `test:int` y los e2e de teléfono). Los metadatos
  atrasados son el principal riesgo de rechazar un móvil nuevo: **subirla al
  menos una vez por trimestre**.
- **Informe de teléfonos guardados** (`npm run phones:report`, `-- --detail`
  para el CSV): solo lectura, con el rol de la app, clínica a clínica y por
  lotes de 1 000 filas, cada uno en una transacción `READ ONLY`. Clasifica
  cada teléfono de pacientes, responsables y sedes (`E164_VALID`,
  `E164_PROBABLE_WRONG_CODE` con su propuesta, `E164_INVALID`,
  `NATIONAL_NO_REGION`, `NATIONAL_AMBIGUOUS`, `NATIONAL_VALID`,
  `NATIONAL_INVALID`), cuenta las banderas `CHANGED_SINCE_DX329`,
  `WHATSAPP_NOT_MOBILE` y `HAS_EXTENSION`, y aparte los pacientes de WhatsApp
  sin teléfono (`whatsappWithoutPhone`). Nunca imprime un número completo: a
  lo sumo 4 dígitos, y nunca más de un tercio del número.
  - `CHANGED_SINCE_DX329` y `WHATSAPP_NOT_MOBILE` se calculan con la región
    de la sede principal, así que son **aproximadas en clínicas con varias
    regiones** (`multiRegion: true`): pueden sobrar o faltar pacientes de
    otras sedes.
- **Runbook del despliegue** (API antes que web):
  1. Antes de `migrate deploy`, la consulta previa (sedes vivas por
     `countryCode`) a la nota de versión, y el 100 % de la API y de los
     workers en DX-312 o posterior.
  2. `prisma migrate deploy`: M1 añade las dos columnas y el CHECK
     (`ACCESS EXCLUSIVE` breve, `lock_timeout` de 5 s; si falla, `migrate
     resolve --rolled-back` y repetir); M2 rellena la región con el país,
     clínica a clínica con `COMMIT` (a mano, **sin** `psql -1`), solo en
     sedes sin región y sin marca, y sin escribir la marca.
  3. API y workers hasta el 100 %. Después, **antes de la web**, como el
     DBA y en una transacción, el relleno de las sedes que hayan creado
     réplicas anteriores (el número de filas, a la nota de versión):
     ```sql
     UPDATE "locations" SET "defaultPhoneRegion" = "countryCode"
      WHERE "defaultPhoneRegion" IS NULL
        AND "defaultPhoneRegionSetAt" IS NULL;
     ```
     Vale igual en cualquier despliegue posterior, también tras un rollback.
     La consulta posterior tiene que dar `sin_decidir = 0`:
     ```sql
     SELECT count(*) FILTER (WHERE "defaultPhoneRegion" IS NULL
                               AND "defaultPhoneRegionSetAt" IS NULL) AS sin_decidir,
            count(*) FILTER (WHERE "defaultPhoneRegion" IS NULL
                               AND "defaultPhoneRegionSetAt" IS NOT NULL) AS sin_prefijo_elegido,
            count(*) FILTER (WHERE "defaultPhoneRegion" <> "countryCode") AS distinta
       FROM "locations";
     ```
  4. `npm run phones:report` (y `-- --detail` para el dueño), a la nota de
     versión. No se corrige ningún teléfono sin una decisión del dueño.
  5. Solo entonces, la web.
  6. **Rollback**: primero la web y luego la API. No hay nada que deshacer
     en la BD: la API anterior no conoce las columnas, y una sede que cree
     queda sin región (un número sin `+` no se lee; fallo seguro) hasta el
     relleno del paso 3.

## Calendario de días hábiles y festivos de la sede (DX-316)

Cada sede tiene sus días hábiles de la semana (lunes a viernes por defecto) y
sus festivos, que carga la clínica (a mano o importando un `.csv` o `.ics`).
Dentalix no trae festivos de ningún país.

- **Despliegue**: `npx prisma migrate deploy` a una hora de poco tráfico y
  ANTES de desplegar la API nueva. Son cuatro migraciones
  (`20261028170000_dx316_enums`, `…170100_dx316_audit_events_idx`,
  `…170200_dx316_location_calendar_tables` y
  `…170300_dx316_location_calendar_default`), cada una atómica.
- **Si falla CUALQUIERA de las cuatro** (normalmente por su
  `lock_timeout`), Prisma la deja marcada como fallida y otro
  `migrate deploy` se para con P3009. No se despliega la API nueva; se
  ejecuta, con el nombre completo de la que falló (lo da
  `npx prisma migrate status`):
  ```
  npx prisma migrate resolve --rolled-back <migración que falló>
  npx prisma migrate deploy
  ```
  La API se despliega solo cuando `migrate deploy` termina bien.
- **INSERT crudo en `locations` como owner**: el trigger
  `locations_default_working_calendar` crea la fila de calendario de cada
  sede nueva con la RLS de quien inserta. Un script o una migración de datos
  que inserte sedes con `row_security = off` y `NO FORCE` solo en
  `locations` falla («query would be affected by row-level security policy»), porque
  `location_working_calendars` sigue en FORCE. Hay que quitar y devolver
  FORCE también en `location_working_calendars`, en la misma transacción
  (además de `payment_receipt_counters` y `payment_receipts`, que ya pedía
  el trigger del prefijo de recibos). Falla con error, nunca deja una sede
  sin calendario en silencio.

## Indicaciones postoperatorias (DX-222)

Las indicaciones que el paciente se lleva tras una exodoncia, un cordal, una
endodoncia, un implante o una prótesis: plantillas de la clínica, sugeridas
por la cita y entregadas impresas, por email o por enlace de WhatsApp, con el
texto congelado tal como lo recibió. Módulo `post-op-instructions`;
migraciones `20261020000000_dx222_enums`,
`20261020000100_dx222_post_op_instructions`,
`20261020000200_dx222_audit_events_idx` y
`20261020000300_dx222_email_template`.

- **Plantillas y versión** (`post_op_instruction_templates`): `code` (2–20
  mayúsculas, números o guiones; único por clínica y no se edita), `title`,
  `body`, `version` y `active`. Cambiar título o texto sube `version`;
  activar, desactivar o cambiar vínculos no. Una inactiva sale del selector y
  no se entrega (400). Variables admitidas: `{{paciente}}`,
  `{{profesional}}`, `{{clinica}}`, `{{telefono_sede}}` y `{{fecha}}` (día
  civil de la cita en la zona de la sede); una desconocida da 400. Los
  **vínculos** (`post_op_instruction_template_links`) dicen cuándo sugerirla:
  por un procedimiento del catálogo (`catalogItemId`) o por un tipo de cita
  (`appointmentTypeId`), exactamente uno por fila (CHECK); llegan en
  `catalogItemIds`/`appointmentTypeIds` y se reemplazan completos. Uno de
  otra clínica da 400. `POST /post-op-templates/samples` carga las 5 de
  ejemplo (`POI-EXO`, `POI-CORDAL`, `POI-ENDO`, `POI-IMPLANTE`,
  `POI-PROTESIS`) que la clínica aún no tiene: repetirlo no duplica ni pisa
  una propia con el mismo código. RLS FORCE y FK compuestas por `tenantId`.
- **Entrega inalterable** (`post_op_instruction_deliveries`): guarda el
  texto ya renderizado (`renderedText`) y la copia de código, título y
  `templateVersion`, así que editar la plantilla después no cambia lo
  entregado. El trigger `post_op_instruction_deliveries_immutable` (función
  `post_op_deliveries_immutable`) rechaza cualquier
  UPDATE salvo poner `firstOpenedAt` una sola vez (de NULL a una fecha) y
  cualquier DELETE con `app.current_tenant` fijado; `deliveredAt` lo pone la
  BD. FK compuestas a paciente, cita, sede y plantilla.
- **Canales** (`channel`): `PRINT` solo registra la entrega (el documento
  sale de `GET /patients/:patientId/post-op-deliveries/:id`); `EMAIL` encola
  la plantilla de email `post-op-instructions` con el enlace, al paciente o,
  si es menor o no tiene email, a su responsable que recibe avisos (DX-203,
  `sentToResponsible`); `WHATSAPP_LINK` devuelve el número y el mensaje para
  `wa.me`, que lleva solo el saludo, la clínica y el enlace: **nunca** el
  procedimiento ni el texto clínico. La baja de envíos del paciente (DX-128),
  la falta de email o de un teléfono válido dan 422 en español sin
  guardar nada; el tope de emails de la clínica o del destinatario da 429.
  Si el outbox falla después de guardar, la entrega queda (y auditada) con
  `emailQueued: false` para que el personal use otro canal.
- **Enlace público** (`GET /public/post-op-instructions/:token`, sin
  sesión, tenant por host y límite por IP): EMAIL y WHATSAPP_LINK crean un
  token del que solo se guarda el hash (`tokenHash`) y caduca a los 30 días
  (`tokenExpiresAt`). Muestra la marca de la clínica, el teléfono de la sede,
  el título, la versión y el texto tal como se entregó; ningún otro dato del
  paciente. Token desconocido, malformado o de otra clínica: 404; caducado:
  410. Leer no marca nada (los previsualizadores de enlaces la abren solos):
  la página llama a `POST …/:token/opened`, que fija `firstOpenedAt` la
  primera vez y no cambia nada después.
- **Rutas y roles**: `GET /post-op-templates` (los 4 roles) y `POST`,
  `PATCH /:id` y `POST /samples` (solo ADMIN); `GET
  /appointments/:appointmentId/post-op-instructions` (sugeridas por los
  vínculos, el resto, canales disponibles y entregas hechas) y `POST
  …/deliveries` (los 4 roles: recepción entrega en el mostrador); `GET
  /patients/:patientId/post-op-deliveries` y `…/:id` (historial de la ficha).
- **Auditoría** (`audit_events`): `POSTOP_TEMPLATE` (CREATE, CREATE con
  `reason: SAMPLE_TEMPLATES`, UPDATE) y `POSTOP_DELIVERY` (CREATE con el
  canal como `reason`, auditado en el caso de uso; VIEW de sugerencias,
  historial y documento, con el paciente). Nunca se registran la URL, el
  token ni el destinatario. La apertura pública no se audita: queda en
  `firstOpenedAt`.
- **Teléfono de la sede** (`locations.phone`): `PATCH /locations/:id` (solo
  ADMIN); `null` o vacío lo quita. Es el `{{telefono_sede}}` de las
  indicaciones y el que muestran la página pública y el email.
- **Demo**: las 5 de ejemplo; `POI-EXO` vinculada a «Exodoncia simple»
  (`CX-EXO-SIMPLE`), `POI-CORDAL` a la exodoncia quirúrgica y los cordales,
  `POI-ENDO` al tipo de cita «Endodoncia»; la sede principal con teléfono
  `+57 601 555 0101`, y una entrega impresa de `POI-EXO` para la última cita
  atendida de un día anterior.

## Pagadores y coberturas del paciente (DX-153)

Con qué pagador, plan y afiliado se atiende cada paciente: un catálogo de
pagadores por clínica (EPS, prepagadas, mutuas, empresas) y hasta 5
coberturas por paciente, una principal. Sustituye al texto libre
`patients."insurerEps"`. Módulos `payers` y `patient-coverages`; migraciones
`20261020210000_dx153_enums`, `20261020210100_dx153_payers_and_coverages` y
`20261020210200_dx153_insurer_eps_backfill`.

- **Tablas**: `payers` (nombre, `type` MUTUA_ES | PREPAGADA_CO | EPS_CO |
  EMPRESA | OTRO, `country`, `active`) y `patient_coverages` (paciente,
  pagador, plan, nº de afiliado, titular, vigencia `validFrom`/`validTo`,
  `isPrimary`, notas). Ambas con RLS FORCE y FK compuestas por `tenantId`
  (un pagador o paciente de otra clínica es imposible en la BD). Se quitan en
  blando.
- **Reglas**: nombre de pagador único por clínica entre pagadores vivos
  (mayúsculas y tildes se comprueban en la API; 409 en español, con mensaje
  propio si el que coincide está desactivado); CHECK de tipo y país (EPS_CO y
  PREPAGADA_CO solo con país CO); `validTo` no anterior a `validFrom`; hasta 5
  coberturas vivas por paciente; la primera es principal aunque no se pida y
  `isPrimary: true` en otra desmarca la anterior en la misma transacción
  (con candado por paciente); la principal no se puede desmarcar sin marcar
  otra. Un pagador con coberturas no se retira: se desactiva. Solo un pagador
  activo admite coberturas nuevas. El estado de cada cobertura (vigente,
  vencida, pendiente) se calcula contra el día civil de la sede.
- **Endpoints**: `GET|POST /payers`, `PATCH|DELETE /payers/:id` y
  `GET|POST /patients/:patientId/coverages`, `PATCH|DELETE …/:coverageId` y
  `POST …/:coverageId/verification` (SEC-049, solo ADMIN).
  `GET /patients/:id`, `GET /patients` y `GET /appointments` traen `coverage`
  (resumen de la principal viva, sin nº de afiliado; un número fijo de
  consultas por página). `GET /patients?payerId=` filtra por pagador.
- **Roles**: leer pagadores, los 4 roles; crearlos, ADMIN y recepción;
  editar, desactivar y retirar, ADMIN. Las coberturas las gestionan los 4
  roles, como «Editar» de la ficha (son datos administrativos, no clínicos).
- **Auditoría**: las coberturas escriben UPDATE de PATIENT con `reason`
  `COVERAGE_CREATED|CHANGED|VERIFIED|REMOVED` (SEC-049; el alta era
  `COVERAGE_ADDED`); la metadata lleva los nombres de los campos y, salvo en
  el retiro, el tipo de pagador, los 4 últimos del nº de afiliado y si está
  verificada; nunca el nº entero ni el titular. El catálogo de pagadores no
  se audita. El GET de coberturas tampoco (la ficha ya se audita).
- **Relleno**: la migración `…_insurer_eps_backfill` crea un pagador por
  clínica y texto normalizado (tipo OTRO, sin país; el ADMIN lo reclasifica) y
  una cobertura principal por paciente con `insurerEps` no vacío, marcada
  `migratedFromInsurerEps`. Es idempotente, incluye archivados y no toca
  `insurerEps`. Esa columna queda legada, sin lectores desde DX-322; DROP en
  fase 2. La API ya no la lee, no la escribe ni la expone (`@ignore` en el
  esquema), y un cliente antiguo que la mande no da error: se descarta.
- **Demo**: `npm run seed:demo` crea 8 pagadores (Sura EPS, Sanitas,
  Compensar, Nueva EPS, Famisanar, Salud Total, Coomeva, Empresa Alfa) y una cobertura
  principal por paciente que tenía aseguradora, con una vencida y una
  pendiente para ver los tres estados. El seed omite una clínica demo ya creada.
- **Tests**: `payers.e2e-spec.ts`, `patient-coverages.e2e-spec.ts`,
  `appointments-coverage.e2e-spec.ts`, `patient-coverages.int-spec.ts` (RLS,
  FK compuestas, relleno) y los recuentos de `seed-demo.int-spec.ts`.

## Convenios y listas de precios (DX-105)

Precio de lista por sede y convenios por pagador (descuento porcentual o lista
de precios) que fijan el precio de cada ítem del plan al añadirlo. Módulos
`price-lists`, `agreements` y `patient-agreements`; migraciones
`20261020230000_dx105_enums` a `20261020230500_dx105_plan_item_pricing_location_fk`.

- **Tablas**: `price_lists` (nombre, moneda, sede o toda la clínica, activa),
  `price_list_items` (lista, prestación del catálogo, precio), `agreements`
  (nombre, pagador, `kind` PERCENT_DISCOUNT | PRICE_LIST, `percent`,
  `percentByCategory` en JSONB, lista, sede, vigencia, activo) y
  `patient_agreements` (una asignación viva por paciente; el historial son las
  retiradas; puede enlazar una cobertura del mismo pagador). Todas con RLS
  FORCE y FK compuestas por `tenantId`. Los ítems del plan guardan una foto
  inmutable: `basePrice`, `catalogPrice`, `priceSource`, `agreementId`,
  `agreementName` y `pricingLocationId`. Cambiar o quitar el convenio después
  no re-precia nada. El catálogo trae `allowDiscount`: sin él, el ítem no
  admite descuento y el descuento masivo lo salta.
- **Orden de resolución** al añadir un ítem sin `price`: convenio vigente del
  paciente (porcentaje por categoría, luego general; o su lista de precios),
  lista activa de la sede de escritura, precio de catálogo. Una lista de otra
  moneda que la del plan se ignora y se pasa al siguiente paso. «Hoy» es el
  día civil de la sede. `GET /patients/:id/price-quote` devuelve la misma
  resolución sin escribir.
- **Semántica de `catalogPrice` (R1)**: es la referencia resuelta (la del
  convenio, la lista o el catálogo), no el precio de catálogo; `basePrice`
  guarda siempre el de catálogo. Un precio por debajo de `catalogPrice` cuenta
  como descuento discrecional; la rebaja del convenio no.
- **Roles**: leer convenios, los 4 roles; listas de precios, ADMIN y rol
  clínico; crear, editar y retirar ambos, ADMIN. Asignar convenio al paciente,
  los 4 roles, con la elegibilidad de SEC-047 (abajo). `price-quote`, roles
  clínicos.
- **Elegibilidad al asignar (SEC-047)**: como la rebaja de convenio no cuenta
  como descuento discrecional, asignar un convenio no puede saltarse el tope
  por rol de DX-204. Un convenio de un **pagador externo** (tipo MUTUA_ES,
  PREPAGADA_CO, EPS_CO o EMPRESA) exige `coverageId` con una cobertura del
  paciente, de ese pagador, sin retirar y **vigente hoy** (día civil de la
  sede), para cualquier rol, ADMIN incluido: si no, 400 en español. Un
  convenio **interno** (pagador de tipo OTRO: cortesía, empleados, socios)
  lo asigna ADMIN, con la cobertura opcional (si viene, se valida igual). Otro
  rol solo si manda una cobertura **migrada** (`migratedFromInsurerEps`, que
  solo crea el relleno de DX-153 y la API no puede marcar) del paciente y de
  ese pagador, vigente; si no, 403 en español con la pista de pedir al
  administrador que reclasifique el pagador. `GET /agreements`, la
  asignación y las coberturas devuelven `payer.type` y
  `migratedFromInsurerEps` para que la web sepa qué pedir. Matriz en
  `test/patient-agreements-eligibility.e2e-spec.ts`.
- **Cobertura verificable (SEC-049)**: cierra el riesgo que SEC-047 dejaba
  aceptado (cualquier rol creaba la cobertura con solo `{ payerId }` y
  asignaba el convenio en la llamada siguiente, BE-043).
  - Con un pagador externo, el **nº de afiliado o póliza es obligatorio** al
    crear la cobertura, con UNA regla igual para todo pagador externo, sin
    supuestos de país ni de tipo (DX-311; 400 en español que nunca repite el
    número): tras normalizar (extremos recortados, espacios colapsados), de 4
    a 40 caracteres, solo letras, dígitos, espacio y `-./`, al menos un dígito
    y no un mismo carácter repetido. Con OTRO sigue siendo opcional. Las
    coberturas que ya existían sin nº (migradas o anteriores) se leen y editan
    igual; solo se pide al cambiar su pagador o su número.
  - **Verificar** (`POST /patients/:patientId/coverages/:coverageId/verification`,
    solo ADMIN) guarda quién y cuándo (`verifiedById`, `verifiedAt`,
    `verifiedByName`). Recibe `checkedMemberNumber`, el nº que el ADMIN tenía
    delante: si ya no es el guardado, o el pagador cambió entretanto, 409.
    Cambiar el pagador o el nº de afiliado **borra la verificación** y deja
    la cobertura declarada por quien la edita (`declaredById`; en las
    anteriores, `createdById`).
  - Al asignar, un rol que no es ADMIN no puede usar una cobertura cuyo
    pagador o nº declaró él mismo si no está verificada (403 en español que
    dice qué falta). Sí puede si la verificó un ADMIN, si la registró otro
    usuario o si es migrada. ADMIN asigna como antes. La comprobación se
    repite en la transacción con la cobertura `FOR SHARE`. Una cobertura de
    otra clínica sigue siendo 400 «Cobertura no encontrada.».
  - Auditoría: alta, cambio y verificación son `COVERAGE_CREATED`,
    `COVERAGE_CHANGED` y `COVERAGE_VERIFIED` (antes del alta era
    `COVERAGE_ADDED`), con el rol en `actorRole` y en `metadata.coverage` el
    tipo de pagador, los **4 últimos** caracteres del nº (ninguno si el nº
    tiene 4 o menos: serían el número entero) y si quedó verificada; nunca el
    número entero. Los logs redactan cualquier clave `memberNumber`.
  - Migración `20261024152000_sec049_coverage_verification`: tres columnas
    NULL sin relleno y un CHECK `NOT VALID` + `VALIDATE` (verificada = quién
    y cuándo, o ninguno). Matriz rol × verificada × creada por sí mismo en
    `test/patient-coverages-verification.e2e-spec.ts`.
  - Riesgo que queda: dos usuarios que no son ADMIN pueden repartirse los
    pasos (uno registra la cobertura y otro asigna el convenio). El informe de
    descuentos sigue mostrando quién asignó el convenio y la auditoría, quién
    registró la cobertura.
- **Nota de despliegue (SEC-047)**: antes de publicar, avisa a los ADMIN de
  las clínicas con convenios vivos de pagador OTRO: desde la versión con
  SEC-047 solo los asigna un administrador (salvo con una cobertura migrada
  del paciente). Si el pagador es una aseguradora o una empresa, que lo
  reclasifiquen en Ajustes → Pagadores. Consulta (como owner, salta la RLS):

  ```sql
  SELECT t."name" AS clinica, py."name" AS pagador, a."name" AS convenio,
         count(DISTINCT pa."patientId") FILTER (WHERE pa."deletedAt" IS NULL) AS pacientes_asignados,
         count(DISTINCT pc."patientId") FILTER (WHERE pc."migratedFromInsurerEps") AS pacientes_con_cobertura_migrada
    FROM "agreements" a
    JOIN "payers" py ON py."tenantId" = a."tenantId" AND py."id" = a."payerId"
    JOIN "tenants" t ON t."id" = a."tenantId"
    LEFT JOIN "patient_agreements" pa
      ON pa."tenantId" = a."tenantId" AND pa."agreementId" = a."id"
    LEFT JOIN "patient_coverages" pc
      ON pc."tenantId" = a."tenantId" AND pc."payerId" = py."id" AND pc."deletedAt" IS NULL
   WHERE a."deletedAt" IS NULL AND py."deletedAt" IS NULL AND py."type" = 'OTRO'
   GROUP BY t."name", py."name", a."name"
   ORDER BY t."name", py."name", a."name";
  ```
- **Auditoría**: recursos `AGREEMENT` y `PRICE_LIST`; la asignación se audita
  como `PATIENT` con `reason` `AGREEMENT_ASSIGNED|AGREEMENT_REMOVED`. La
  metadata lleva nombres de campos, nunca importes ni datos del paciente.
- **Presupuesto v2**: `GET …/quote` devuelve `version: 2` con `agreement`
  (`{name, payerName}` del primer ítem con convenio; con varios, los nombres
  unidos por « · »), `listPrice` y `agreementName` por línea y
  `agreementSaving` en los totales (Σ max(0, `basePrice` − `catalogPrice`) de
  los ítems con convenio). El hash es `dentalix-plan-quote-v2`; el v1 se
  conserva intacto, `parseQuoteContent` lee ambos y una aceptación firmada
  compara con el hash de su propia versión, así que las firmadas antes
  siguen con `integrityOk: true`.
- **Demo**: `npm run seed:demo` crea las listas «Tarifa Sede Norte» (5
  precios, sede Norte) y «Convenio Alfa» (3), el pagador «Empresa Alfa», los
  convenios «Sura EPS −15 %» y «Empresa Alfa lista» y los asigna a tres
  pacientes. Se crean al final para no cambiar los precios de los planes de la
  demo.
- **Tests**: `plan-quote.spec.ts`, `price-lists.e2e-spec.ts`,
  `agreements.e2e-spec.ts`, `patient-agreements.e2e-spec.ts`,
  `treatment-plans-pricing.e2e-spec.ts`, `treatment-plan-quote.e2e-spec.ts`,
  `price-lists-agreements.int-spec.ts` y los recuentos de `seed-demo.int-spec.ts`.

## Documentos del paciente (DX-151)

Radiografías, fotos, remisiones, consentimientos firmados escaneados e
informes adjuntos a la ficha del paciente. El contenido vive en el almacén de
ficheros (ver [Ficheros en un bucket S3 (DX-084)](#ficheros-en-un-bucket-s3-dx-084));
la BD guarda solo la clave y los metadatos. Módulo `patient-documents`;
migraciones `20261020200000_dx151_enums`,
`20261020200100_dx151_patient_documents`,
`20261020200200_dx151_audit_events_idx` y
`20261020200300_dx151_teeth_check`.

- **Tabla** (`patient_documents`): `category` (`XRAY`, `PHOTO`, `REFERRAL`,
  `SIGNED_CONSENT`, `REPORT`, `OTHER`), `clinicalDate` opcional (día civil,
  nunca futuro en la zona de la sede), `toothNumbers` (hasta 8 dientes FDI;
  CHECK por elemento y de una sola dimensión, migración `…_teeth_check`; la
  API rechaza un diente repetido), `notes` (hasta 500), nombre original,
  tipo detectado, tamaño y `sha256`. El mismo contenido no se sube dos veces
  al mismo paciente: índice único parcial `patient_documents_active_sha256_key`
  (`tenantId`, `patientId`, `sha256`) entre los **no anulados** (409 «ya
  subido»; anulado, se puede volver a subir). La **sede** queda sellada al
  subir (la activa por `X-Location-Id` o, sin cabecera, la principal).
  `uploadedAt` y `createdAt` los pone la BD con la **hora del servidor**
  (trigger `dx_patient_documents_server_time`), sea cual sea lo que mande el
  cliente. **Inalterable**: el trigger `dx_patient_documents_immutable`
  (`search_path` fijo) rechaza cualquier UPDATE salvo la **anulación única**
  (`voidedAt`, `voidedById` y `voidReason` de NULL a un valor, una sola vez)
  y cualquier DELETE o TRUNCATE. RLS FORCE y FK compuestas por `tenantId` a
  paciente y sede, todas RESTRICT.
- **Lista blanca y detección por contenido**: PDF, JPEG, PNG, HEIC, DOCX y
  DICOM. **Decide el contenido**, no la extensión ni el tipo que declara el
  cliente: `sniffDocument` lee las firmas (`%PDF-`, `FF D8 FF`, PNG con
  `IHDR`, `ftyp` HEIC, ZIP con `word/document.xml` en el directorio central,
  preámbulo DICOM + `DICM`). HTML, SVG, EML o cualquier otra cosa **nunca**
  entran: 400 «Tipo de archivo no admitido. Se aceptan PDF, JPG, PNG, HEIC,
  DOCX y DICOM.». Si el tipo o la extensión declarados son de otro tipo de la
  lista (un PNG renombrado `.pdf`), 400 «El contenido del archivo no coincide
  con su tipo.»; `application/octet-stream` o un DICOM sin extensión no dicen
  nada y pasan. Nada rechazado llega al almacén.
- **Subida**: la web sube DIRECTO al bucket (`upload-url` + `complete`, ver
  [Subida directa al bucket (DX-259)](#subida-directa-al-bucket-timeouts-de-s3-y-avatares-cacheables-dx-259)).
- **Límites**: 20 MB por fichero (multer corta antes de leer más) → **413**
  con cuerpo en español «El archivo supera el máximo de 20 MB.»; un solo
  fichero por subida; los demás errores de multipart también salen en
  español (filtro `MultipartErrorsFilter` del controlador). Notas hasta 500
  caracteres y motivo de anulación de 3 a 500, contados en puntos de código
  como los CHECK de la BD; en ambos, **sin caracteres de control** (salvo
  tabulador y saltos de línea): 400 «El texto contiene caracteres no
  permitidos.».
- **Claves sin PII**: `patient-documents/<tenantId>/<documentId>.<ext>`; el
  nombre original solo está en la BD. La API nunca expone la clave ni el
  tenant. **URL firmadas con `Content-Disposition`** (300 s,
  `PATIENT_DOCUMENT_URL_TTL_SECONDS`): `inline` solo para PDF, JPEG y PNG
  (`inlineViewable` en la respuesta; HEIC, DOCX o DICOM en línea dan 400
  «Este tipo solo se puede descargar.»), `attachment` para cualquiera. La
  disposición, el nombre (saneado, con `filename*` UTF-8) y el tipo detectado
  van **dentro de la firma** (S3: `response-content-*` en SigV4; disco: el
  HMAC), así que tocarlos invalida la URL. Con el disco, `/files/signed` es la
  única ruta enmarcable (`frame-ancestors *`, sin `X-Frame-Options`), con
  `nosniff` y `private, no-store`, y solo sirve tipos de la lista blanca:
  firmar o pedir otro tipo es 403.
- **Rutas y roles** (`/patients/:patientId/documents`; los cuatro roles leen y
  suben): `POST /` multipart (`file`, `category`, `clinicalDate?`,
  `toothNumbers?` separado por comas, `notes?`); `GET /?category=&tooth=`
  (más recientes primero, anulados incluidos); `GET /:id`; `GET
  /:id/url/inline` y `GET /:id/url/download` (`Cache-Control: no-store`; un
  anulado se sigue pudiendo descargar); `POST /:id/void` `{ reason }`, solo el
  **autor o ADMIN** (403 a los demás, 409 si ya está anulado). **Sin PATCH,
  PUT ni DELETE**, a propósito: un documento se corrige anulándolo y subiendo
  otro. Paciente u otro documento de otra clínica: 404.
- **Auditoría** (`audit_events`, `PATIENT_DOCUMENT`, siempre con el
  paciente): CREATE al subir; VIEW con `reason` `DOCUMENT_LIST` (listado),
  sin motivo (detalle) y `DOCUMENT_VIEW` (URL en línea); EXPORT con
  `DOCUMENT_DOWNLOAD`; VOID. **Nunca** se registran el nombre del fichero, el
  de los usuarios, la clave ni la URL. Las llamadas que fallan no dejan
  evento.
- **Retención**: un documento **nunca se borra**, ni de la BD ni del almacén
  (la anulación lo marca y lo conserva); sigue la retención de la historia
  clínica (DX-039), así que el ciclo de vida del bucket no debe expirar
  versiones actuales. Si el INSERT falla después de guardar el fichero, el
  objeto huérfano se borra en el acto (es lo único que se borra).
- **CSP de la web**: la web ve los PDF en un `iframe` y las imágenes en
  `<img>` desde la URL firmada, así que su CSP añade a `frame-src` e
  `img-src` el origen de los ficheros: `NEXT_PUBLIC_FILES_ORIGIN` (variable
  de la **web**, no de la API; por defecto el origen de la API, que es el de
  `/files/signed` con el disco). Con S3 en producción, pon ahí el origen del
  bucket (`https://<bucket>.s3.<región>.amazonaws.com` o el de R2). La API no
  tiene variables nuevas.
- **Pendiente tras DX-089**: la sede de escritura la resuelve solo
  `PrismaPatientDocumentRepository.resolveWriteLocationId` (hoy la activa o
  la principal); cuando DX-089 llegue a main pasa a
  `tenantContext.writeLocationId(tx)`, un cambio de una línea.
- **Demo**: `seed:demo` no crea documentos (no hay ficheros de ejemplo que
  guardar en el almacén).

## Gastos de la sede y caja menor (DX-274)

Lo que gasta cada sede: factura o cuenta por pagar con categoría, proveedor,
importe, fechas y soporte, pagada total o parcialmente. Módulo `expenses`;
migraciones `20261024150000_dx274_enums`, `…150100_dx274_expenses`,
`…150200_dx274_cash_adjustment_outflow`, `…150300_dx274_audit_events_idx`,
`…150400_dx274_expense_idempotency` y
`…150500_dx274_idempotency_immutable`. Incluye las salidas de caja menor
(el dinero del cajón) y el resumen mensual «ingresos − gastos» con CSV.

- **Tablas**: `expense_categories` (propias de la clínica; las predefinidas
  son constantes de código), `expenses` y `expense_payments`, con RLS FORCE y
  FK compuestas por clínica. El pago hereda sede y moneda del gasto por una FK
  de cuatro columnas. Sin DELETE en la BD: anular conserva todo.
- **Zona horaria explícita**: gastos, salidas y resumen usan la zona IANA
  guardada en el horario de cada sede. Si falta o no es válida, responden
  `409 LOCATION_TIMEZONE_REQUIRED` con el mensaje «Configura una zona horaria
  válida para la sede y vuelve a intentarlo.». No se deduce del país ni del
  servidor; tras guardar el horario se puede reintentar. Un rango manual del
  resumen también necesita las zonas para agrupar los ingresos de cada sede.
- **Estado derivado**: `PENDING`, `PARTIAL`, `PAID` o `VOIDED` salen de la
  anulación y de la suma de pagos vivos; `overdue` es «no pagado del todo con
  el vencimiento ya pasado» en el día civil de la sede. La lista lo calcula en
  una sola consulta por página (filtros `status` y `overdue` incluidos).
- **Reglas**: la factura no es futura y el vencimiento no es anterior a ella;
  la categoría es una predefinida o una propia activa (400 `Elige una
  categoría válida.`) y el gasto guarda una foto del nombre; el proveedor se
  normaliza (espacios) y admite 200 caracteres. La suma de pagos vivos no
  pasa del importe (400 con lo pendiente) y se comprueba con el gasto `FOR
  UPDATE`, así que dos pagos simultáneos no se pasan. El día del pago no es
  futuro en la sede. Un gasto con cualquier pago (aunque esté anulado) no
  cambia de sede ni de moneda; su importe sí, nunca por debajo de lo pagado.
  Con `cashRequireOpenSession`, un pago en efectivo fuera de caja es 409.
- **Idempotencia**: `POST /expenses` y `POST /expenses/:id/payments` aceptan
  `Idempotency-Key` (UUID); repetir la misma petición devuelve el original y
  otro cuerpo con la misma clave es 422 (como los abonos, DX-109).
- **Soporte** (PDF, JPG o PNG, hasta 20 MB; HEIC se convierte a JPG en el
  navegador): subida directa al bucket como los documentos del paciente
  (DX-259). `POST /expenses/attachments/upload-url` devuelve `{ uploadId,
  target, maxBytes }`; el navegador sube a
  `expense-receipts/pending/<tenantId>/<uploadId>` y entrega el `uploadId` en
  `attachmentUploadId` del alta o a `POST /expenses/:id/attachment` (solo si
  aún no tiene soporte). La API comprueba tamaño, SHA-256 y tipo por
  contenido, y lo copia a `expense-receipts/<tenantId>/<attemptId>-<sha16>.<ext>`;
  cada completación genera su UUID exclusivo para que la limpieza de un
  intento fallido nunca borre el soporte de otra transacción en vuelo;
  si el contenido no vale borra el objeto y responde 400. Los pendientes que
  nadie adjunta los borra el ciclo de vida del bucket a las 24 h (ver
  [Ficheros en un bucket S3 (DX-084)](#ficheros-en-un-bucket-s3-dx-084)).
  `GET /expenses/:id/attachment/url?disposition=inline|attachment` da una URL
  firmada de 300 s, auditada como VIEW (inline) o EXPORT (descarga).
- **Caja menor** (R1, R5, R6): un pago puede salir del cajón
  (`payment.fromCashSession` en el alta, `fromCashSession` en `POST
  /expenses/:id/payments`): método `CASH`, `paidOn` = hoy en la sede y caja
  abierta de quien paga en la sede del gasto (409 `Abre tu caja en esta sede
  para pagar desde el cajón.`); la caja se toma con `FOR SHARE`, así que un
  cierre simultáneo gana o pierde limpio. `POST /cash-sessions/current/outflows`
  (ADMIN y recepción, `Idempotency-Key`) crea gasto y pago de una vez en la
  caja abierta de quien llama, con fecha de hoy y la sede de esa caja. El
  efectivo esperado del arqueo resta las salidas (`fondo + abonos + ajustes −
  salidas`, puede quedar negativo). Anular una salida con la caja abierta la
  saca del cálculo («Salidas anuladas»); con la caja ya cerrada sigue restando
  ahí y la anulación entra como ajuste `OUTFLOW_VOID` positivo en la caja
  abierta de quien anula (o pendiente de la siguiente de la sede). Con arqueo
  ciego, nada de esto devuelve el esperado; la lista de salidas del turno sí.
- **Resumen mensual**: `GET /expenses/summary?from&to&locationId` (ADMIN,
  rango de hasta 366 días, 400 en español si no): una fila por mes × sede ×
  moneda con `income`, `categories` (gasto por categoría, mayor primero),
  `expensesTotal` y `net` (ingresos − gastos; puede ser negativo). Los gastos
  no anulados cuentan por **fecha de factura** (devengado, estén pagados o no)
  y los ingresos son los abonos vivos por el **día civil de su sede** (mes y
  rango en la zona de cada sede, no en UTC). Las monedas no se convierten.
  Ambas lecturas salen de una misma foto `REPEATABLE READ`. Sin permiso sobre
  una sede, ni sus gastos ni sus ingresos entran.
- **CSV** (ADMIN, `@Audit` EXPORT con `reason` `EXPENSE_LIST` o
  `EXPENSE_SUMMARY`, `Cache-Control: no-store`, UTF-8 con BOM y CRLF, celdas
  de texto entre comillas, sin saltos de línea y con prefijo `'` si empiezan
  por `= + - @`, importes con los decimales de su moneda):
  `GET /expenses.csv` (mismos filtros que la lista, una línea por gasto, hasta
  10 000: más es 400 «acota el periodo») y `GET /expenses/summary.csv` (por
  mes, sede y moneda: `Ingresos`, un `Gasto` por categoría, `Total gastos` y
  `Neto`). Los comparte `src/shared/csv/csv-cells.ts` con cartera y descuentos.
- **Endpoints**: `GET|POST /expenses`, `GET|PATCH /expenses/:id`,
  `POST /expenses/:id/void`, `POST /expenses/:id/payments`,
  `POST /expenses/:id/payments/:paymentId/void`,
  `GET /expenses/suppliers?query` (hasta 20 proveedores distintos, el de uso
  más reciente primero) y `GET|POST /expense-categories`,
  `DELETE /expense-categories/:id`. Respeta las sedes permitidas del usuario.
- **Roles**: toda la gestión, el resumen y los CSV, ADMIN. ADMIN y recepción:
  la autorización de subida del soporte, las sugerencias de proveedor, leer
  las categorías y la salida de caja menor desde su propia caja.
- **Auditoría**: recurso `EXPENSE` (CREATE, UPDATE, VOID con `reason`
  `EXPENSE_VOIDED` o `PAYMENT_VOIDED`, `PAYMENT_ADDED`, VIEW y EXPORT); la
  metadata solo lleva los nombres de los campos, nunca el proveedor ni la
  descripción.
- **Despliegue** (todo aditivo; el código anterior sigue funcionando con las
  migraciones aplicadas):
  1. Aplicar las migraciones `20261024150000` … `20261024150500` (`prisma
     migrate deploy`). `…150300` crea un índice no concurrente sobre
     `audit_events` (bloquea sus escrituras mientras se construye, como DX-279):
     mejor en una hora de poco tráfico. `…150200` toma un bloqueo breve sobre
     `cash_session_adjustments`.
  2. **Antes o junto al despliegue de la API**, añadir al bucket de producción
     la regla de ciclo de vida de `expense-receipts/pending/` (24 h): la
     migración no la aplica y sin ella las subidas que nadie adjunta no se
     limpian. Es la misma regla que `patient-documents/pending/`; ver
     [Ficheros en un bucket S3 (DX-084)](#ficheros-en-un-bucket-s3-dx-084)
     (JSON de AWS y, en R2, una regla por prefijo).
  3. Sin variables de entorno nuevas.
- **Demo**: `npm run seed:demo` crea tres gastos de la sede principal (uno
  pagado, uno pagado a medias con el vencimiento pasado y uno pendiente) y una
  salida de caja menor de recepción en el turno ABIERTO de la tarde; la caja
  cerrada de la mañana no se toca, así que su arqueo (diferencia de −2.000)
  sigue igual.

## Importación de pacientes desde CSV/XLSX (DX-107)

Un ADMIN trae su base de pacientes de Excel o de otro software sin teclearla.
Módulo `src/modules/patient-imports`; rutas bajo `/api/v1/patient-imports`,
**todas solo ADMIN** (403 en español al resto):

| Ruta | Qué hace |
|------|----------|
| `GET /template` | Plantilla CSV (UTF-8 con BOM) con las columnas admitidas y dos filas de ejemplo ficticias |
| `POST /inspect` | Paso 1: lee el fichero (multipart `file`) y devuelve cabeceras, mapeo sugerido y 5 filas. No escribe nada |
| `POST /` | Paso 2, **dry-run**: `file` + `mapping` (JSON `{campo: cabecera}`; sin él, el sugerido) + `defaultDocType`. Valida, deduplica y guarda el lote `VALIDATED` con totales y errores por fila. **No crea ni toca pacientes** |
| `POST /:id/confirm` | Paso 3: `{ duplicateMode: SKIP \| FILL_EMPTY }` → lote `QUEUED` y trabajo `patient-imports.process` encolado en la misma transacción |
| `GET /:id` | Estado, progreso (`progress.percent`) y los 200 primeros errores/duplicados |
| `GET /:id/errors.csv` | Informe completo: fila, columna, tipo, motivo y valor |
| `POST /:id/undo` | Deshacer el lote |
| `GET /` | Historial (sin los dry-run sin confirmar) |

- **Ficheros**: CSV o .xlsx de hasta **5 MB** (413) y **10.000 filas** con
  datos (400); como mucho 50.000 filas físicas (vacías incluidas) y 100
  columnas. El formato lo decide el contenido y debe cuadrar con la
  extensión; un .xls antiguo o un Excel con contraseña se rechazan con el
  arreglo. CSV en UTF-8 (con o sin BOM), Windows-1252/Latin-1 o UTF-16 LE con
  BOM; separador `;`, `,` o tabulador (el que más aparece en las primeras
  líneas, o la pista `sep=`). La cabecera es la primera fila con al menos dos
  celdas escritas (un título encima se salta); los números de fila son los de
  la hoja. El .xlsx lo lee un lector propio sin dependencias
  (`domain/xlsx-reader.ts`): escáner LINEAL con cursor (nunca regex sobre la
  hoja; una etiqueta sin cerrar es un 400 al momento), primera hoja, cadenas
  compartidas/en línea, prefijos de espacio de nombres, números sin notación
  científica y fechas por su estilo (serie fuera de rango = número, no 500);
  sin DTD/entidades externas (XXE) y con un tope de **32 MB descomprimidos
  entre todas las partes**, aunque la cabecera del ZIP mienta (zip bomb). No
  se guardan filas vacías ni celdas más allá de la columna 100, y la lectura
  y la validación ceden el hilo cada 500 filas (zlib asíncrono): un fichero
  grande no para la API. Cualquier fallo inesperado del lector es un 400
  genérico en español. **El fichero no se guarda**: solo su nombre, tamaño,
  SHA-256, el mapeo y lo que necesita el informe.
- **Tope de lecturas y throttle (SEC-046)**: leer un fichero (inspect,
  dry-run `POST /` y hoja de saldos `POST /:id/balances`) puede ocupar ~30–85
  MB y segundos de CPU, y cualquiera que se registre es ADMIN de su clínica.
  Por eso:
  - **Recepción del cuerpo, con un semáforo de subidas propio**: las tres
    rutas llevan `ImportUploadSlotGuard` + `UploadSlotInterceptor`: el guard
    de DX-259 sobre un semáforo SOLO de importaciones, con el mismo tope
    (`UPLOAD_MAX_CONCURRENCY`) y plazos (`UPLOAD_IDLE_TIMEOUT_MS` y
    `UPLOAD_MAX_DURATION_MS`, 408 al vencer). Así una ráfaga de
    importaciones, o quien gotea sus cuerpos, no deja sin plaza el avatar,
    los documentos ni `/files/uploads` de las demás clínicas (y al revés).
    Multer escribe el fichero en el temporal de las subidas
    (`os.tmpdir()/dentalix-uploads`), no en memoria.
  - **Plazas de lectura** (`ImportReadSlotInterceptor`, detrás del
    `FileInterceptor`): se toman **con el fichero ya en disco**, así que un
    cliente que gotea el cuerpo no retiene ninguna. Como mucho
    `PATIENT_IMPORT_MAX_CONCURRENCY` lecturas a la vez en cada réplica
    (default **2**, 1..64) y `PATIENT_IMPORT_MAX_CONCURRENCY_PER_CLINIC` por
    clínica (default **1**, 1..64). Sin plaza, **503** al momento (sin cola)
    con `Retry-After: 5`: «Ya se está leyendo otro archivo de importación de
    esta clínica…» o «Hay otras importaciones leyéndose ahora mismo…»; el
    temporal se borra igual. Todo corre después de `JwtAuthGuard` y
    `RolesGuard`: un anónimo (401) o un no-ADMIN (403) no ocupa plaza de
    subida ni de lectura.
  - **Liberación**: la plaza de lectura vuelve al terminar el handler (bien
    o con error); la de subida y el temporal, al terminar también (o al
    abortar el cliente a mitad del cuerpo: `UploadSlotInterceptor`).
  - **Rate limit `patient-import`**: 10 lecturas por minuto por clínica +
    usuario (`RATE_LIMIT_PATIENT_IMPORT_LIMIT`/`_TTL_MS`), con **un balde
    común** para las tres rutas (no uno por ruta); **429** en español con
    `Retry-After`. Corre antes que las plazas: un 429 no ocupa ninguna; un
    503 sí gasta una unidad del balde (con `Retry-After: 5`, un reintento a
    mano no lo agota).
  - Prueba de carga (lenta: no corre por defecto; en CI, en su propio paso):
    `RUN_SLOW_TESTS=1 npm run test:e2e -- test/patient-imports-load`. 20
    lecturas en paralelo del XLSX de la auditoría: el pico de RSS crece < 300
    MB (medido: +26 MB una clínica, +62 MB veinte clínicas; sin el tope, +916
    MB). A medio plazo: `readImportFile` en un `worker_thread` con
    `resourceLimits`.
- **Validación por fila** (motivo en español, columna tal como se llama en el
  fichero): nombres y apellidos obligatorios; tipo de documento genérico
  (DX-327) por, en este orden, los nombres locales de la clínica, el código o
  el nombre genérico (`NATIONAL_ID`, «Documento nacional», `PASSPORT`,
  «Pasaporte»…) y los códigos y sinónimos anteriores, que se aceptan como su
  tipo genérico y sin etiqueta, o el de por defecto; nº de documento con una
  sola regla para cualquier tipo (sin espacios, puntos, comas, guiones ni
  barras, en mayúsculas, hasta 30 letras y dígitos: «V-12.345.678» →
  «V12345678»; notación científica de Excel detectada); fecha DD/MM/AAAA,
  AAAA-MM-DD o serie de Excel, no futura ni anterior a 1900; sexo por alias;
  email; teléfonos en E.164 con la región telefónica de la **sede del lote**
  (la de `X-Location-Id` o la de escritura; `readPhone`, DX-329); uno no
  válido, ambiguo o con extensión, tal cual si tiene de 7 a 15 dígitos.
- **Deduplicación** por (tipo, nº de documento), con la clave sin puntos ni
  guiones: dentro del fichero gana la primera fila; contra los pacientes vivos
  de la clínica, el existente se **salta** o se le **rellenan solo los campos
  vacíos** (nunca nombre ni documento; nunca pisa un dato). El mismo número con
  OTRO tipo es un error (la BD ya impone un paciente vivo por nº de documento,
  `patients_tenant_doc_key`, pero compara el texto tal cual). Por eso el alta
  y la edición manual de un paciente y cada bloque de la importación toman un
  candado de transacción por (clínica, documento normalizado)
  (`pg_advisory_xact_lock(hashtextextended('patient-doc:<clínica>:<clave>'))`,
  `patients/infrastructure/patient-doc-lock.ts`) y buscan por la clave
  normalizada: «1.111.111» y «1111111» nunca dan dos pacientes, y el alta
  manual de un documento ya existente escrito distinto da 409.
- **Clave del documento indexada (DX-287)**: la clave es
  `patients."docKey"` (solo `[0-9A-Z]`: se quita todo lo demás y luego se
  pasa a mayúsculas, sin depender de Unicode ni de la locale). La calcula
  la BD con `public.dx_doc_key` en el trigger `patients_doc_key` (también
  para las altas del código anterior) y es la misma regla que `docKey()`
  (`patients/domain/doc-key.ts`). Alta, edición, dry-run, hoja de saldos y
  cada bloque de la importación comparan `"docKey" = …` / `= ANY(…)` con el
  índice parcial `patients_tenant_doc_key_live_idx ("tenantId","docKey")
  WHERE "deletedAt" IS NULL AND "docNumber" IS NOT NULL`: bajo RLS FORCE es
  un Index Scan (con 60k pacientes, 0,03 ms por alta y ~2–4 ms por bloque
  de 250, frente a 80 ms y 130 ms recorriendo la clínica). La expresión
  `regexp_replace(upper(...))` no sirve en SQL de la app: no es LEAKPROOF y
  bajo RLS no usa índice (lo vigila `test/invariants/doc-key-sql.spec.ts`).
  El índice no es único: hay duplicados ambiguos anteriores a DX-107; el
  candado de asesoría sigue siendo quien serializa las altas.
- **Trabajo por bloques** (DX-085): 250 filas por transacción corta; la
  clínica sigue operando (solo se bloquean las filas del bloque, nunca la tabla
  `patients`). Idempotente (retoma desde las filas `PENDING`); al agotar los 5
  intentos el lote queda `FAILED` con lo hecho. Una fila con un error suyo
  (no pasajero) queda `FAILED` y el resto sigue; un fallo pasajero (BD,
  conexión, interbloqueo) sube y lo reintenta la cola. Una importación en cola
  o en curso por clínica (índice único parcial; 409). Un lote cuyo trabajo
  murió (intentos agotados, arriendo vencido o purgado) pasa a `FAILED` al
  consultar o confirmar en la clínica y en la tarea
  `patient-imports.reap-stuck.hourly`: nunca deja la clínica bloqueada.
- **Retención (datos del fichero)**: un dry-run caduca a las 24 h o al subir
  otro (`EXPIRED`): se BORRAN sus filas preparadas y se vacían sus errores.
  Los errores por fila de los lotes terminados o deshechos se vacían a los
  **90 días** (`issuesPurgedAt`), en la tarea diaria
  `patient-imports.expire-validated.daily`; desde entonces `errors.csv` da
  **410**. `filledValues` (lo rellenado) se conserva mientras se pueda
  deshacer.
- **Ley 1581 / RGPD (DX-037)**: los importados nacen **sin** autorización de
  datos registrada (`data_processing_consents` vacía, `dataConsentAccepted`
  false) y la ficha la marca «Pendiente». La importación no inventa
  consentimientos. `patients.import_batch_id` dice qué lote creó a cada uno.
- **Deshacer**: retira en blando solo los pacientes que creó el lote y revierte
  los campos que rellenó si siguen con el valor del lote. Se niega (409) si
  alguno de los creados aparece en CUALQUIER tabla con FK a `patients` (leída
  de `pg_constraint`: citas, lista de espera, planes, pagos, historia,
  odontograma, dentición, periodoncia, recetas, documentos, consentimientos,
  implantes, coberturas, convenios (DX-105), responsables, cobranza,
  indicaciones…; las visitas del plan de DX-256 cuelgan de citas y planes), salvo las
  filas del lote y `patient_ledgers`. Una tabla nueva queda cubierta sola; el
  int-spec la enumera para que se revise.
- **Cartera (DX-155)**: el INSERT de pacientes no dispara el refresco de
  `patient_ledgers` (solo su UPDATE de `deletedAt`); el deshacer retira por
  sentencias de 1.000 pacientes, cada una refrescando su resumen, con
  `app.current_tenant` fijado (RLS FORCE intacta).
- **Auditoría**: `PATIENT_IMPORT_BATCH` con `CREATE` (dry-run), `UPDATE`
  (`IMPORT_CONFIRMED`), `DELETE` (`IMPORT_UNDONE`) y `EXPORT` (errors.csv);
  `metadata.importBatch` lleva el SHA-256, el modo y los totales (solo
  números). `GET /:id` no se audita: la pantalla lo consulta cada pocos
  segundos mientras importa. Logs solo con ids y contadores.
- **Inyección CSV**: en `errors.csv` y la plantilla, una celda que empieza por
  `= + - @` (también tras espacios), tabulador o CR se antepone con `'`.
- **Tablas**: `patient_import_batches` y `patient_import_rows`, RLS FORCE y FK
  compuestas por tenant (sede, lote, paciente). Rendimiento: el dry-run de
  10.000 filas tarda unos segundos (e2e: < 60 s).
- **Migraciones sin bloqueo largo de `patients`**: `…130100` solo añade
  `import_batch_id` y la FK `NOT VALID` (no lee filas); el índice parcial va
  `CONCURRENTLY` en `…130300` y el `VALIDATE` en `…130400`, con `ANALYZE` de
  la columna antes del `NO FORCE`: con esa estadística la comprobación usa el
  índice parcial (vacío) y no recorre la tabla (~1 ms con 1 M de pacientes,
  frente a ~160 ms de recorrido con ACCESS EXCLUSIVE). Lo vigila
  `test/migrations/dx107-patients-lock.spec.ts`.
- **Lector de ficheros acotado**: XLSX con ≤ 16.384 celdas por fila, ≤ 64.000
  estilos, ≤ 1 M de cadenas compartidas y 4 M de pasos del escáner por
  fichero (400 en español), cediendo el hilo cada 8.192 pasos; CSV
  Windows-1252 decodificado en nativo.
- **Supresión parcial (Ley 1581)**: «Actualizar solo campos vacíos» nunca
  rellena los campos suprimidos de un paciente con `partially_suppressed_at`
  (el dry-run lo avisa en la fila).
- **Probar a mano**: `prisma/demo/pacientes-importacion-ejemplo.csv` (25 filas
  con separador `;`, errores, un repetido y uno de la clínica demo).

## Saldo inicial «Saldo migrado» (DX-262)

Porción 2 de DX-107: la clínica que llega de Excel o de otro programa trae las
deudas de sus pacientes. En el asistente de importación, después de validar
los pacientes y antes de confirmar, se puede subir una **hoja de saldos**
(CSV o XLSX, mismos topes: 5 MB y 10.000 filas). Solo ADMIN.

- **Columnas** (por sinónimos, sin tildes; plantilla en
  `GET /patient-imports/balances-template`): `numero_documento`, `importe`,
  `moneda`, `fecha_antiguedad` (opcional) y `concepto` (opcional, ≤ 200;
  por defecto «Saldo migrado»). Sin documento, importe o moneda: 400.
- **Endpoints**: `POST /patient-imports/:id/balances` (dry-run, lote
  VALIDATED y vigente; volver a subirla la reemplaza), `DELETE
  /patient-imports/:id/balances` (quitarla), `GET
  /patient-imports/:id/balances/errors.csv`. El lote (`GET /:id`) trae
  `balances` (totales por moneda del archivo y de lo que se importa, lo
  importado de verdad, avance y deshecho) y `balanceIssues`.
- **Validación por fila** (en español, con su columna): documento que no es
  de ningún paciente vivo de la clínica ni del archivo de pacientes del lote
  (o ambiguo: «1.111» y «1111» anteriores a DX-107), importe no positivo, con
  más de 2 decimales o ilegible, moneda fuera del catálogo `currencies` (el
  mismo de planes y abonos), fecha futura o irreconocible. Importe: el último
  separador es el decimal si hay «.» y «,»; con uno solo seguido de 3 cifras,
  de miles (`150.000`); en una celda numérica de XLSX, siempre decimal.
- **Un saldo por paciente y moneda y lote**: las filas repetidas se suman (aviso
  `MERGED` en el dry-run), con la fecha más antigua y el primer concepto.
  Las monedas nunca se mezclan ni se convierten.
- **La misma hoja dos veces no duplica la deuda** (QA D1): si el paciente ya
  tiene un saldo migrado VIVO en esa moneda de otro lote, cada fila suya es
  un error del dry-run que dice cuál («Este paciente ya tiene un saldo
  migrado vivo de 80.000,00 COP (lote «x.csv» del dd/mm/aaaa, corte
  dd/mm/aaaa): no se crea otro…») y no se importa. Solo con el campo
  `addToExisting=true` del multipart (casilla «Añadir aunque ya tenga saldo
  migrado» en la web, guardada en el lote como `balanceAddToExisting`) se
  crea otro, con el aviso `EXISTING_BALANCE`. El trabajo lo vuelve a
  comprobar al importar (un lote confirmado y aún en cola cuando se valida
  el siguiente): sin la casilla, esa fila queda SKIPPED y se cuenta en
  `progress.existing`. Un saldo retirado no cuenta.
- **Al confirmar**, el trabajo `patient-imports.process` importa primero los
  pacientes y después los saldos en bloques de 500 (transacción corta, un
  `INSERT … ON CONFLICT DO NOTHING` por bloque: idempotente). Sin fecha en el
  archivo, la fecha de corte es el día de la importación en la zona de la
  sede del lote y queda marcada **aproximada**. La sede del saldo es la del
  lote (la de `X-Location-Id` al subir los pacientes).
- **Tabla `opening_balances`**: RLS FORCE, FK compuestas por tenant (paciente,
  sede, lote), moneda del catálogo, `CHECK amount > 0`, concepto 1–200, único
  `(tenant, lote, paciente, moneda)`. Inmutable salvo la retirada
  (`voidedAt`/`voidedById`, trigger `opening_balances_guard`); la app no la
  borra.
- **Estado de cuenta (DX-011)**: `openingBalances[]` (fecha de corte, «aprox.»,
  concepto, abonado y pendiente), `summary[].openingBalance` (el cargo
  original) y `summary[].openingPending` (lo que queda tras sus abonos: lo que
  «incluye» el saldo, QA D5); `balance = budgeted + openingBalance − paid`.
  También en el familiar (DX-203).
- **Cartera (DX-145/DX-155)**: `patient_ledgers_compute` añade `openings` al
  resumen; un saldo migrado vivo hace deudor al paciente (aunque no tenga
  planes) y envejece desde su fecha de corte (aproximado si lo es). Si no hay
  cita atendida, abono ni plan presentado, la sede de la deuda es la del
  último saldo. Triggers por sentencia en `opening_balances` refrescan el
  resumen (no hay que pausarlos: cada bloque refresca a sus ≤ 500
  pacientes).
- **Cobrar el saldo migrado** (revisión C1): `POST
  /opening-balances/:id/payments` (ADMIN y RECEPTION, como cualquier abono)
  registra un abono contra el saldo: `payments.openingBalanceId` en lugar de
  `treatmentPlanId` (CHECK `payments_target_check`: exactamente uno; FK
  compuesta `(tenantId, openingBalanceId, patientId)` → mismo paciente y
  clínica). Lleva su recibo de caja consecutivo por sede (DX-136, la foto
  dice «Saldo migrado · concepto · corte» y el pendiente tras el abono; el
  correo, «Concepto» y «Saldo pendiente tras este abono», revisión N1),
  entra en la caja por turno y su arqueo (DX-027), admite Idempotency-Key
  (DX-109), cuenta para los compromisos de pago (DX-150) y se anula con
  `DELETE /payments/:id` como cualquier abono. En la moneda del saldo y sin
  pasar de lo pendiente: el saldo se bloquea `FOR UPDATE` en la transacción
  del abono (dos cobros a la vez no lo pasan) y si no cabe, 400 «El abono
  supera lo pendiente del saldo migrado: quedan …». El estado de cuenta da
  `paid`/`pending` por saldo, el resumen de cartera guarda lo abonado
  (`openings[i][5]`) y solo debe si queda pendiente, y la antigüedad envejece
  solo lo pendiente.
- **Deshacer**: el del lote se niega (409) si algún saldo migrado del lote
  tiene abonos VIVOS (los anulados no cuentan); el bloqueo sale del catálogo
  (toda FK a `opening_balances.id`, filtrando `deletedAt`/`voidedAt` si la
  tabla los tiene). `POST /patient-imports/:id/balances/undo` (solo ADMIN)
  retira SOLO los saldos del lote aunque sus pacientes ya tengan citas u otra
  actividad (el lote sigue COMPLETED). Lo retirado (cuántos y cuánto por
  moneda) queda en el lote (`balances.undoneCount`/`undoneTotals`) y en la
  auditoría. Las horas de la retirada, en UTC de la BD.
- **Retención**: a los 90 días de terminar o deshacer el lote (con los errores
  de DX-107) se borran sus saldos preparados (`patient_import_balance_rows`:
  documento e importe del fichero); un dry-run caducado los borra al caducar.
- **Rendimiento del dry-run**: la búsqueda de documentos va por conjuntos
  (`= ANY(keys)` agrupado, en patients por `"docKey"` con su índice y en las
  filas del lote con `public.dx_doc_key`): 5.000 claves contra 20.000
  pacientes en menos de 2 s (int).
- **Topes**: la suma de las filas de un paciente y moneda no puede pasar de
  `DECIMAL(14,2)` (error de la fila); una celda XLSX con ruido de coma
  flotante (`178500.00000000003`, `300000000.00000006`) se redondea a 2
  decimales con una tolerancia relativa de 16 ULP del valor (revisión N2;
  un tercer decimal real, ≥ 0,001, sigue siendo error hasta el tope). Un documento con
  varios pacientes vivos al importar no se adivina: se cuenta aparte
  (`progress.ambiguous`).
- **Auditoría**: `PATIENT_IMPORT_BATCH` `UPDATE` con `reason`
  `IMPORT_BALANCES_VALIDATED` / `IMPORT_BALANCES_REMOVED` /
  `IMPORT_BALANCES_UNDONE`, `EXPORT`
  `IMPORT_BALANCE_ERRORS`; `metadata.importBatch` lleva el hash de la hoja,
  sus contadores, `balanceTotals` (lo previsto por moneda) y
  `balanceUndoneTotals` (lo retirado de verdad); totales AGREGADOS, nunca el
  de un paciente ni documentos.

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
  VERIFIED de una clínica viva, en la clínica del dominio, con clave por
  (dominio, ronda); la
  ronda es la hora UTC truncada, así que repetir el barrido en la misma hora
  (reintento, arriendo perdido) no cuenta dos veces el mismo fallo. Si el
  TXT con el token sigue publicado, `failedChecks` vuelve a 0; si no, suma uno
  y al llegar a `DOMAIN_RECHECK_MAX_FAILURES` (default **3**, 1..20) seguidos
  pasa a **DISABLED**: deja de enrutar y queda `disabledAt`. Solo cuentan
  las respuestas definitivas (NXDOMAIN, NODATA o TXT sin el token). Un DNS
  que no responde (SERVFAIL, timeout, conexión rechazada…) se reintenta con el
  backoff de la cola y, si sigue sin responder en el último intento, la ronda
  **no cuenta** (ni suma ni reinicia; log `domains.recheck_inconclusive`). El
  token es público, así que contar esos errores no protegería de nada y
  desactivaría dominios legítimos (o todos, si cae el resolver). Un DISABLED
  se puede volver a verificar (mismo token) o eliminar.
  La desactivación la hace el sistema, sin usuario: `audit_events` exige un
  actor (CHECK `audit_events_actor_check`), así que queda en el log
  (`domains.disabled`, con ids, sin el host) y en la propia fila
  (`disabledAt`, `failedChecks`, `lastCheckedAt`).
- **Freno del barrido (DX-220, OPS-033)**: el barrido consulta primero el TXT
  de **todos** los dominios de la ronda (16 a la vez). Si más del **50 %**
  falla (sin el TXT con el token **o** sin respuesta del DNS: un DNS medio
  roto mezcla timeouts con NXDOMAIN falsos) y son al menos **4**, lo probable es que falle el DNS
  propio (o la salida a internet), no que media flota de clínicas pierda su
  dominio a la vez: la ronda **no cuenta para ninguno** (no encola nada) y
  queda `domains.recheck_suspect` en el log (ronda y contadores, sin hosts).
  Si no, encola cada comprobación con el resultado ya consultado (`result`:
  `found`/`missing`); los que no respondieron van sin él y su trabajo
  consulta el DNS con los reintentos de la cola, como antes.
- **DNS acotado (DX-220)**: `NodeDnsResolver` crea un `Resolver` propio por
  consulta con `timeout` `DNS_RESOLVER_TIMEOUT_MS` (3000) y `tries`
  `DNS_RESOLVER_TRIES` (2), más un plazo duro de timeout × tries (unos 6 s):
  c-ares alarga el timeout en cada reintento y por cada servidor, y antes se
  usaba el resolver global sin tope. Al vencer cancela SU consulta y da
  `ETIMEOUT` («no se sabe», nunca «no hay registro»).
- **DNS inyectable**: puerto `DNS_RESOLVER` (`NodeDnsResolver` en producción);
  los tests lo sustituyen por `FakeDns` (y el reloj por `DomainClock`).

## Acceso de soporte del superadmin: MFA y break-glass (SEC-008)

Un superadmin de plataforma (`users.isPlatformAdmin`, se otorga solo por
migración o a mano en la BD) no es miembro de las clínicas de los clientes.
Antes bastaba su contraseña para entrar a cualquiera como ADMIN con un refresh
de 30 días; ahora ese acceso es **break-glass**:

- **MFA (TOTP) obligatorio**, enrolado desde la sesión de PLATAFORMA (login en
  el apex). Sin MFA el login en una clínica responde `401` con
  `code: "MFA_NOT_ENROLLED"` (plan de transición: los superadmins existentes
  nacen sin MFA y no pueden entrar a clínicas hasta enrolarlo).
- **Espera de seguridad tras el alta**: el MFA recién activado no abre
  clínicas hasta pasados `BREAK_GLASS_MFA_COOLDOWN_MINUTES` (default 1440 =
  24 h; `0` en local para probar). Mientras, el login responde `401` con
  `code: "MFA_COOLDOWN"` y `availableAt`, sin mirar el código.
- **Código + motivo** en el mismo `POST /auth/login`: `mfaCode` (6 dígitos,
  ventana ±30 s, un código no vale dos veces) y `breakGlassReason` (10–500
  caracteres). Tras una contraseña correcta, si faltan → `401` con
  `code: "BREAK_GLASS_REQUIRED"`; código erróneo o reutilizado → el `401`
  genérico («Invalid credentials»), que suma al bloqueo por intentos (DX-048)
  y a un contador propio del código MFA por superadmin (mismo backoff; solo
  lo reinicia un código correcto, no un login correcto en el apex). En
  espera → `429` con `Retry-After`.
  Quien no conoce la contraseña recibe siempre el `401` genérico: no se
  revela si el email existe ni si es superadmin.
- **Token corto y sin refresh**: solo un access token ADMIN con
  `breakGlass: true`, que dura `BREAK_GLASS_TTL_MINUTES` (default 30, máx.
  60). La respuesta trae `breakGlass: true` y `expiresAt`; en modo cookie se
  borra la cookie de refresh. `POST /auth/refresh` rechaza cualquier refresh
  break-glass y cualquier sesión de clínica sin membresía (también los refresh
  de 30 días emitidos a superadmins antes de SEC-008).
- **Rastro inmutable visible para la clínica**: cada acceso inserta una fila
  en `platform_access_audit` (quién, clínica, motivo, IP, user agent, cuándo y
  hasta cuándo). Append-only (trigger; el rol de la app no tiene UPDATE,
  DELETE, TRUNCATE ni TRIGGER), RLS forzada por tenant. El ADMIN la lee en
  `GET /api/v1/support-accesses` (cursor `nextCursor`, `limit` ≤ 100) y en la
  web, en Ajustes → «Accesos de soporte». El login queda además en
  `audit_events` con `metadata.reason = "BREAK_GLASS"`.
- **Secretos cifrados**: AES-256-GCM con `MFA_ENCRYPTION_KEY` (obligatoria en
  producción; fuera, derivada de `JWT_ACCESS_SECRET`) y el id del usuario como
  dato autenticado. Cambiar la clave obliga a re-enrolar.

**Enrolar el MFA** (en la web: área de plataforma del apex, `/admin`, tarjeta
«Verificación en dos pasos»; o por API con el token de plataforma):

```bash
# 1. Login en el APEX (sin subdominio de clínica) → token de plataforma
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'X-Tenant-Host: localhost' -H 'Content-Type: application/json' \
  -d '{"email":"soporte@dentalix.app","password":"…"}'          # → accessToken
# 2. Alta: devuelve el secreto (base32) y el otpauth:// para la app
curl -s -X POST http://localhost:3000/api/v1/platform/mfa/enrollment \
  -H 'X-Tenant-Host: localhost' -H "Authorization: Bearer $TOKEN"
# 3. Confirmar con el código que muestra la app
curl -s -X POST http://localhost:3000/api/v1/platform/mfa/enrollment/confirm \
  -H 'X-Tenant-Host: localhost' -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"code":"123456"}'
```

Con el MFA activo no se puede volver a enrolar (`409`): perder el móvil exige
borrar a mano `mfaTotpSecretEnc`, `mfaEnabledAt` y `mfaLastUsedStep` del
usuario en la BD (y re-enrolar). **Riesgo de la transición**: mientras un
superadmin no haya enrolado, quien robe su contraseña podría enrolar su propio
MFA desde el apex (que solo pide contraseña). Mitigación: la espera de
seguridad de arriba (24 h sin break-glass tras el alta), el evento de log
`platform_mfa.enabled` (conviene alertar sobre él) y el `409` que recibe el
dueño real al intentar su alta, que le pide avisar. Enrolad a todos los
superadmins en cuanto se despliegue.

**Probar en local** (con `BREAK_GLASS_MFA_COOLDOWN_MINUTES=0` en `.env`): convierte en superadmin a un usuario que NO sea miembro
de la demo (`UPDATE users SET "isPlatformAdmin" = true WHERE email = '…'`),
enrola el MFA en http://localhost:3001/admin y entra en
http://demo.localhost:3001/login con su email: la web pide el código y el
motivo. Luego, como `admin@demo.dentalix.app`, Ajustes → «Accesos de soporte».

## Ficheros en un bucket S3 (DX-084)

Los ficheros (los avatares y los [documentos del paciente](#documentos-del-paciente-dx-151)) pasan por
el puerto `FileStoragePort` (`src/shared/storage`), con dos adaptadores que se
eligen con `STORAGE_DRIVER`:

| `STORAGE_DRIVER` | Adaptador | Uso |
|---|---|---|
| `disk` (defecto) | `DiskFileStorage`, en `STORAGE_DIR` | Solo desarrollo y tests. **Con `NODE_ENV=production` la API no arranca** (el disco del contenedor es efímero, no se comparte entre réplicas y no tiene copia). |
| `s3` | `S3FileStorage` (`@aws-sdk/client-s3`) | Producción: AWS S3, Cloudflare R2 o MinIO. |

Variables de `s3` (las valida `validateEnv` al arrancar; los mensajes nunca
muestran secretos):

| Variable | |
|---|---|
| `S3_BUCKET` | Obligatoria. El bucket **privado** de los ficheros. |
| `S3_REGION` | Defecto `us-east-1`. R2: `auto`. |
| `S3_ENDPOINT` | Vacío = AWS. R2: `https://<cuenta>.r2.cloudflarestorage.com`. MinIO local: `http://localhost:9000`. En producción, https y no local. |
| `S3_FORCE_PATH_STYLE` | `true` para MinIO; `false` (defecto) para AWS y R2. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Las dos o ninguna. Sin ellas el SDK usa su cadena por defecto (rol IAM de la tarea o instancia, lo preferible en AWS). En producción se rechazan las de ejemplo de MinIO. |
| `S3_SSE` | `AES256` o `aws:kms` añade la cabecera de cifrado en cada subida; vacío = el cifrado por defecto del bucket. |

**Claves, no URL.** En la BD se guarda la **clave** del fichero
(`users.avatarUrl` = `avatars/<userId>.<ext>`; en Prisma el campo se llama
`avatarKey`). La URL pública se calcula al responder con la
`FILES_PUBLIC_BASE_URL` vigente, así que cambiar de dominio no rompe ningún
avatar. La migración `20261019224000_dx084_avatar_keys` convierte las URL
absolutas de antes a su clave, y la API reduce a clave cualquier URL de avatar
que una réplica antigua escriba durante un despliegue escalonado. Las claves
se arman con ids, nunca con datos del paciente o del usuario.

**Al desplegar DX-084** (pasar de disco a bucket):
1. Copia los avatares que hubiera en el disco al bucket, con la misma clave:
   `aws s3 sync "$STORAGE_DIR/avatars" "s3://<bucket>/avatars"` (con
   `--endpoint-url` en R2 o MinIO). Lo que no se copie da 404 y la web muestra
   las iniciales; nada se rompe, pero el usuario tendría que subirlo de nuevo.
2. Mientras convivan réplicas de antes y de después de la migración, una
   réplica antigua responde la clave (`avatars/<id>.png`) como `avatarUrl`
   (la web no la puede cargar hasta el siguiente refresco servido por una
   réplica nueva) y puede volver a escribir una URL absoluta al subir un
   avatar. La API nueva lee las dos formas; cuando ya no quede ninguna réplica
   antigua, repite el `UPDATE` de la migración (es idempotente) para que en la
   BD solo queden claves:
   `psql "$DIRECT_URL" -f prisma/migrations/20261019224000_dx084_avatar_keys/migration.sql`.

**Subida de avatares**: PNG, JPEG o WebP de hasta 2 MB (clave versionada y
caché desde DX-259, ver abajo). Se comprueba la
cabecera real del fichero (no solo el tipo que declara el cliente): lo que no
sea de verdad la imagen declarada es un 400 y no llega al almacén. El tipo con
el que se sirve sale de la extensión de la clave, con `nosniff`.

**Público y privado.**
- Lo público (avatares; logos en el futuro) tiene una URL estable:
  `FILES_PUBLIC_BASE_URL/avatars/<nombre>`. La sirve la API leyendo del
  almacén, así que cualquier réplica la sirve y el bucket no se abre al
  público.
- Lo privado (DX-008) se entrega con `getSignedUrl(key, ttlSeconds)`: con S3
  es una URL SigV4 directa al bucket que caduca a los `ttlSeconds` (1 s – 7
  días); con el disco, una URL de la API (`/files/signed`) firmada con HMAC
  por una clave aleatoria del proceso. **Nada clínico con URL pública.**

**El bucket en producción** (lo crea quien opera, no la API):
1. **Privado**: bloqueo de acceso público activado (AWS «Block Public Access»;
   en R2 sin dominio público ni `r2.dev`). Ninguna política anónima.
2. **Cifrado del lado del servidor**: cifrado por defecto del bucket con SSE-S3
   (AES256) o SSE-KMS con una clave propia; R2 cifra siempre en reposo. Si la
   política del bucket exige la cabecera, pon `S3_SSE`.
3. **Versionado** activado: un reemplazo o un borrado (el avatar anterior se
   borra al subir uno nuevo) deja una versión anterior recuperable. Es la base
   de la copia de ficheros de DX-082 (replicación a otra cuenta o región).
4. **Ciclo de vida**: expirar las versiones no actuales a los 30 días y
   abortar las subidas multiparte incompletas a los 7 días. Los ficheros
   clínicos de DX-008 seguirán la retención de la historia clínica (DX-039),
   así que **no** se expiran versiones actuales.
5. **Credenciales mínimas**: un usuario o rol solo para la API con
   `s3:GetObject`, `s3:PutObject` y `s3:DeleteObject` sobre
   `arn:aws:s3:::<bucket>/*` y nada más (sin `s3:ListAllMyBuckets`, sin
   permisos de bucket ni de otros buckets). En R2, un token de API «Object
   Read & Write» limitado a ese bucket. Ejemplo de política de AWS:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
       "Resource": "arn:aws:s3:::dentalix-files/*"
     }]
   }
   ```

   Con SSE-KMS, el rol necesita además `kms:Encrypt`, `kms:Decrypt` y
   `kms:GenerateDataKey` sobre esa clave.

**En local** con MinIO (`docker compose up -d minio minio_init` crea los
buckets privados `dentalix-local` y `dentalix-test` con versionado; consola en
http://localhost:9001):

```bash
STORAGE_DRIVER=s3 S3_BUCKET=dentalix-local S3_ENDPOINT=http://localhost:9000 \
S3_FORCE_PATH_STYLE=true S3_ACCESS_KEY_ID=dentalix-minio \
S3_SECRET_ACCESS_KEY=dentalix-minio-local npm run start:dev
```

**Tests.** Los unitarios cubren el adaptador con un cliente simulado. Los de
integración y e2e contra MinIO (`test/storage/s3-file-storage.int-spec.ts`,
`test/storage/s3-avatar.e2e-spec.ts`: subir, servir, reemplazar y borrar el
avatar con **dos réplicas** de la API, un avatar existente con URL absoluta y
la caducidad de una URL firmada) leen `S3_TEST_ENDPOINT`, `S3_TEST_BUCKET`,
`S3_TEST_ACCESS_KEY_ID` y `S3_TEST_SECRET_ACCESS_KEY` de `.env.test`. Sin
`S3_TEST_ENDPOINT` se saltan **de forma visible** (el nombre de la suite dice
`[SALTADO: falta S3_TEST_ENDPOINT]` y se avisa por consola); en la CI el job de
integración levanta MinIO y fija `REQUIRE_S3_TESTS=1`, con lo que faltar la
variable es un fallo. Para correrlos en local con el MinIO de docker-compose,
añade a `.env.test`:

```bash
S3_TEST_ENDPOINT="http://localhost:9000"
S3_TEST_BUCKET="dentalix-test"
S3_TEST_ACCESS_KEY_ID="dentalix-minio"
S3_TEST_SECRET_ACCESS_KEY="dentalix-minio-local"
```

Con otro servidor S3 compatible en lugar de MinIO, ojo: **moto** (5.2.x) no
comprueba firmas ni caducidad de las URL prefirmadas, así que el test «una URL
firmada … caduca al pasar el TTL» falla contra moto (la URL sigue sirviendo)
aunque el adaptador es correcto; la CI usa MinIO, que sí lo comprueba. El
resto de los tests de S3 pasan igual contra moto.

## Subida directa al bucket, timeouts de S3 y avatares cacheables (DX-259)

Antes, un documento de 20 MB pasaba entero por la memoria del proxy de Next
(que aceptaba 25 MB en **cualquier** `/api/v1/*`, de forma anónima) y otra vez
por un `Buffer` de multer en la API; el cliente S3 no tenía timeouts y los
avatares hacían un `GetObject` por petición (OPS-038, OPS-039).

**Documentos: el navegador sube directo al bucket.**

1. `POST /patients/:patientId/documents/upload-url` `{ fileName?, mimeType?,
   sizeBytes, sha256 }` (hex). Comprueba tamaño (1 B – 20 MB; 413 por encima),
   huella, paciente de la clínica, duplicado vigente (409) y sede, y responde
   `{ documentId, method: 'POST', url, fields, expiresAt, maxBytes }`: un
   **POST prefirmado** (`createPresignedPost`) de **15 minutos**
   (`PATIENT_DOCUMENT_UPLOAD_TTL_SECONDS`) con la clave **exacta** que fija la
   API, `patient-documents/pending/<tenantId>/<documentId>` (sin
   `starts-with`: un único objeto), `content-length-range` 1 B – 20 MB,
   `x-amz-checksum-algorithm: SHA256` + `x-amz-checksum-sha256` (el bucket
   rechaza otro contenido), `Content-Type: application/octet-stream` fijo, el
   SSE si hay `S3_SSE` y los metadatos `x-amz-meta-uploaded-by`,
   `-patient-id`, `-declared-size` y `-sha256` (cambiar cualquiera da 403).
   No se audita (no toca la ficha). Límite propio por clínica + usuario,
   `RATE_LIMIT_DIRECT_UPLOAD_LIMIT`/`_TTL_MS` (default 60/min).
2. El navegador envía `fields` (en orden) y el fichero al final en `file` a
   `url`, por XHR con progreso. No pasa por la web ni por la API.
3. `POST /patients/:patientId/documents/:id/complete` `{ category,
   clinicalDate?, toothNumbers?: string[], notes?, fileName?, mimeType? }`:
   valida el formulario (400 **sin** borrar el objeto: se corrige y se
   repite); el objeto pendiente tiene que ser de ESTE usuario y paciente (si
   no, 404 sin tocarlo); `HeadObject` (`ChecksumMode`) da tamaño y SHA-256
   del bucket, que tienen que cuadrar con lo declarado; el tipo se detecta
   leyendo **solo los primeros 64 KB con `Range`** (un DOCX, además, el final
   del ZIP: EOCD y directorio central), con `IfMatch` de la ETag. Mismas
   reglas que el multipart (lista blanca, declarado vs. detectado, 409
   duplicado, auditoría CREATE). Si el contenido no vale (tipo, tamaño o
   huella), **se borra del bucket y responde 400 en español**. Si vale, se
   copia (`CopyObject` con `CopySourceIfMatch`) a
   `patient-documents/<tenantId>/<documentId>-<16 hex del sha256>.<ext>` con
   el tipo detectado (el pendiente se **conserva**), se crea la fila y solo
   entonces se borra el pendiente, sin esperar a que el bucket conteste: si
   ese borrado falla, lo limpia la regla de 24 h (y la copia nunca queda sin
   fila). Repetir
   `complete` de un documento ya creado por el mismo usuario lo devuelve
   (idempotente) **sin** volver a auditar CREATE; otro usuario recibe 404. Si
   dos `complete` del mismo documento se cruzan (doble clic, reintento tras el
   `proxyTimeout`), el que pierde devuelve la fila del que ganó (`created:
   false`), nunca «vuelve a subirlo» ni «ya está en la ficha»: como el
   pendiente solo desaparece cuando la fila ya existe, no verlo (o ver su
   huella como duplicada) significa que el otro ganó. Hasta `complete` el
   objeto no es alcanzable por la API.
4. **El POST prefirmado sirve para varios envíos** mientras no caduca (15
   min), también después de `complete`: S3 no tiene POST de un solo uso. No es
   un problema de seguridad (misma clave y misma huella firmadas, y `complete`
   devuelve la fila ya creada), pero un re-envío deja un pendiente huérfano
   hasta la regla de 24 h; el tope es `RATE_LIMIT_DIRECT_UPLOAD_*`.
5. **Verificar en AWS S3 real (staging) antes de desplegar** que el bucket
   aplica el campo `x-amz-checksum-sha256` del POST (solo está probado contra
   MinIO). Si el proveedor lo ignorase, `complete` falla cerrado (sin
   `ChecksumSHA256` → 400): seguro, pero rompería todas las subidas.

**Con `STORAGE_DRIVER=disk`** (desarrollo y tests) el flujo es el mismo:
`upload-url` responde un formulario equivalente hacia la propia API,
`FILES_PUBLIC_BASE_URL/uploads` (`POST /files/uploads`, firmado con el HMAC
del proceso, misma caducidad, tope y SHA-256), que deja el objeto y su
checksum/metadatos en `STORAGE_DIR/.meta`. Orden de la ruta: con S3, **404
antes de nada** (`DiskDriverOnlyGuard`: ni plaza del semáforo ni disco);
plaza del semáforo con plazos; la firma se comprueba **antes de aceptar el
fichero** (`fileFilter` de multer: los campos llegan antes que `file`), así
que una firma mala o caducada es 403 sin escribir nada; errores de multer en
español (`MultipartErrorsFilter`).

**El multipart de siempre** (`POST /patients/:patientId/documents`) sigue,
para integraciones: multer escribe en un **temporal en disco**
(`os.tmpdir()/dentalix-uploads`, se borra al terminar el handler), el tipo se
lee por rangos, la huella se calcula en streaming y la subida a S3 es en
streaming (`@aws-sdk/lib-storage` `Upload`). Igual el avatar (`POST
/me/avatar`) y `/files/uploads`.

**Semáforo de subidas por réplica**: `UPLOAD_MAX_CONCURRENCY` (default 4,
1..256) peticiones que reciben un fichero a la vez (multipart, avatar,
`/files/uploads`). Sin plaza: **503** «Hay demasiadas subidas en curso…» con
`Retry-After: 5`, antes de leer el cuerpo. **Mientras se recibe el cuerpo**
hay un plazo de inactividad `UPLOAD_IDLE_TIMEOUT_MS` (default 15000) y uno
total `UPLOAD_MAX_DURATION_MS` (default 120000): al vencer, **408** «La subida
tardó demasiado…», se corta la conexión y la plaza queda libre (si no, unos
pocos clientes a 10 B/s retendrían todas las plazas hasta los 300 s del
`requestTimeout` de Node). Con el cuerpo ya recibido los plazos se desarman
(el procesamiento lo acotan los plazos del almacén) y la plaza y el temporal
se devuelven cuando **termina el handler** (`UploadSlotInterceptor`, que va
el primero en `@UseInterceptors`), no al cerrarse la respuesta. Con el default, un multipart de 20 MB por la API
necesita ≥ 1,4 Mbit/s; la web no usa esa ruta (sube directo al bucket).

**Cliente S3** (`createS3Client`): `NodeHttpHandler` con `connectionTimeout`
`S3_CONNECT_TIMEOUT_MS` (default 3000), `requestTimeout` y `socketTimeout`
por tentativa de `S3_REQUEST_TIMEOUT_MS / S3_MAX_ATTEMPTS` (mínimo 250 ms,
para que los reintentos quepan en el plazo total; `throwOnRequestTimeout`:
corta, no solo avisa), agentes con `maxSockets` `S3_MAX_SOCKETS` (default 50) y
`maxAttempts` `S3_MAX_ATTEMPTS` (default 3). Además cada operación lleva un
`AbortSignal` con un plazo TOTAL de `S3_REQUEST_TIMEOUT_MS` (reintentos
incluidos; una subida en partes, uno por parte de 5 MB): al vencer se destruye
el socket y la API responde **503** «El almacén de archivos no responde.
Inténtalo de nuevo en unos minutos.» con `Retry-After: 5`
(`StorageUnavailableError`; también conexión rechazada/cortada y 5xx tras los
reintentos). 10 s y no los 30 s de la auditoría. Además `complete`, el
multipart y el avatar comparten un **presupuesto** de 25 s para todas sus
operaciones (`withStorageBudget`, `UPLOAD_STORAGE_BUDGET_MS`): cada una vence
a lo que quede si es menos que su plazo, así la petición entera cabe en los
30 s del proxy de Next y el navegador ve el 503 en español, no un 500. Un valor fuera de
rango impide arrancar.

**Log `storage.op`**: una línea por operación (`driver`, `op`: put, get,
range, head, copy, delete, head-bucket; `outcome`: ok, not_found,
precondition_failed, timeout, unavailable, error; `durationMs`, `bytes` y, si
falla, el **tipo** del error). Nunca la clave, el nombre del fichero ni nada
del paciente. **Al arrancar** se hace un `HeadBucket` y, si falla, solo se
avisa (`storage.unreachable`): la API arranca igual. El `HeadBucket` necesita
`s3:ListBucket` sobre `arn:aws:s3:::<bucket>` (sin él, el aviso sale siempre).

**Avatares**: clave versionada `avatars/<userId>-<16 hex del sha256>.<ext>`
(cambiar el avatar cambia la URL) servida con `Cache-Control: public,
max-age=31536000, immutable` y ETag, en streaming; uno de antes
(`avatars/<userId>.<ext>`) con `public, max-age=300` y ETag. Una
revalidación con `If-None-Match` hace solo un `HeadObject` y responde 304 sin
descargar el objeto. La ruta anónima `GET /files/avatars/:name` tiene su propio
límite por IP, `RATE_LIMIT_PUBLIC_FILES_LIMIT`/`_TTL_MS` (default 300/min).
La web reduce en el navegador las fotos de más de 900 KB (el proxy copia 1 MB).

**Bucket en producción (además de lo de DX-084)**:

- **CORS** del bucket solo con los orígenes de la web (los subdominios de
  clínica y los dominios propios). AWS S3:

  ```json
  [{
    "AllowedOrigins": ["https://*.dentalix.app"],
    "AllowedMethods": ["POST"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }]
  ```

  (`aws s3api put-bucket-cors --bucket <bucket> --cors-configuration
  file://cors.json` con `{"CORSRules": [...]}`; GET no hace falta: el visor
  carga la URL firmada en `<iframe>`/`<img>`, sin CORS). Un dominio propio de
  clínica (SEC-009) se añade a `AllowedOrigins`. MinIO no tiene CORS por
  bucket (`PutBucketCors` da NotImplemented): es de todo el servidor,
  `MINIO_API_CORS_ALLOW_ORIGIN` (en docker-compose, `*`).
- **Ciclo de vida** de los pendientes: los objetos de
  `patient-documents/pending/` (documentos del paciente) y de
  `expense-receipts/pending/` (soporte de gastos, DX-274) que no llegaron a
  `complete` o al alta del gasto se borran a las 24 h. AWS (junto a las
  reglas de DX-084); es UNA configuración con una regla por prefijo, porque
  `put-bucket-lifecycle-configuration` reemplaza las reglas existentes:

  ```json
  {"Rules": [
    {
      "ID": "pending-24h",
      "Status": "Enabled",
      "Filter": {"Prefix": "patient-documents/pending/"},
      "Expiration": {"Days": 1},
      "NoncurrentVersionExpiration": {"NoncurrentDays": 1},
      "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}
    },
    {
      "ID": "expense-receipts-pending-24h",
      "Status": "Enabled",
      "Filter": {"Prefix": "expense-receipts/pending/"},
      "Expiration": {"Days": 1},
      "NoncurrentVersionExpiration": {"NoncurrentDays": 1},
      "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}
    }
  ]}
  ```

  En R2, una regla de ciclo de vida por cada prefijo
  (`patient-documents/pending/` y `expense-receipts/pending/`) y «Delete
  after 1 day». En local, `minio_init` aplica las dos a `dentalix-local` y
  `dentalix-test` (`mc ilm import`, un solo JSON con las dos reglas).
- **Decisión: Cloudflare R2 no está soportado para la subida directa.** R2 no
  implementa el POST de formulario (PostObject), así que con R2 la web no
  puede subir documentos. Hoy la subida directa exige AWS S3 o MinIO. Si se
  pasa a R2, hay que implementar antes un modo de PUT prefirmado (con
  `Content-Length` y `x-amz-checksum-sha256` firmados) en
  `createDirectUpload` (tarea aparte del tech lead; informe DX-259).
- **Web**: `NEXT_PUBLIC_FILES_ORIGIN` = origen del bucket (CSP `connect-src`,
  `frame-src`, `img-src`).
- La política IAM de DX-084 sirve (`CopyObject` usa `s3:GetObject` del origen
  y `s3:PutObject` del destino); añade `s3:ListBucket` sobre el bucket para el
  `HeadBucket` del arranque.

**Tests**: unitarios (configuración del cliente y del handler, política del
POST prefirmado, plazo por operación → 503, clasificación de errores, log
`storage.op` sin clave, semáforo, sniff por rangos igual que con el fichero
entero, `upload-url`/`complete`); integración contra MinIO
(`test/storage/s3-direct-upload.int-spec.ts`: política, checksum, tamaño,
campos manipulados, caducidad, `Range` e `IfMatch`) y contra un servidor TCP
que acepta y no responde (`test/storage/s3-timeouts.int-spec.ts`: cada
operación falla en ≤ plazo + 0,7 s y no quedan sockets abiertos; sin docker);
e2e `test/patient-documents-direct.e2e-spec.ts` (MinIO, 19 MB subidos por
`curl` con medición del RSS), `test/patient-documents-direct-disk.e2e-spec.ts`
(disco y semáforo) y `test/storage/s3-unavailable.e2e-spec.ts` (503 a tiempo
con el almacén colgado).

## Receta segura (DX-300)

Módulo `prescriptions`, reglas en `src/modules/prescriptions/domain/prescription-safety.ts`
(versión `RX_SAFETY_V1`; fuentes SDCEP *Drug Prescribing for Dentistry* y BNF
for Children, citadas en el módulo junto a los topes de dosis). Es una ayuda a
la prescripción: no sustituye el juicio clínico.

- **Qué lee**: la anamnesis VIGENTE (versión más alta, bajo RLS en la misma
  transacción que el paciente): lista de alergias y casillas
  `safetyFlags.alergiaPenicilina/alergiaAnestesico/alergiaLatex`, medicación
  habitual (`medications[].nombre`), `embarazo`/`semanasEmbarazo`,
  `anticoagulantes`, `bifosfonatos` y `vitalSigns.peso`; y la edad por la fecha
  de nacimiento el día de hoy en la zona de la sede.
- **Reglas**: `ALLERGY`, `INTERACTION` (anticoagulante —cumarínicos, ACOD,
  heparinas o la casilla— con AINE, metronidazol, macrólidos o azoles; solo un
  antiagregante —clopidogrel, AAS…— con AINE; metotrexato con AINE), `PREGNANCY` (AINE desde la semana
  20 o sin semanas; tetraciclinas; metronidazol en el 1.er trimestre),
  `ANTIRESORPTIVE` (informativo), `PEDIATRIC_DOSE` (< 12 años: amoxicilina,
  ibuprofeno y paracetamol en mg/kg por toma y por día; en una combinación
  «875/125 mg» cuenta el primer número; sin peso pide el peso)
  y `NO_ANAMNESIS` (informativo). Cada aviso: `rule`, `code`, `severity`
  (`BLOCKING`/`INFO`), `message` en español y `source`.
- **Previsualización**: `POST /patients/:patientId/prescriptions/safety-check`
  (DENTIST/ADMIN; auditada como `VIEW MEDICAL_HISTORY` con
  `reason: PRESCRIPTION_SAFETY_CHECK`). No guarda nada.
- **Emisión**: recalcula los avisos; con bloqueantes exige `safetyOverride:
  true` (o el `allergyOverride` de clientes anteriores) y `safetyOverrideReason`
  → si no, 409 en español con `safetyAlerts`. La receta guarda
  `safetyRulesVersion`, `safetyAlerts` y `safetyOverrideReason` dentro del hash
  (formato v2); el `audit_event` CREATE lleva `metadata.prescriptionSafety`
  (versión, códigos bloqueantes e informativos y si se confirmó; nunca textos).
- **Migración** `20261024140000_dx300_prescription_safety`: tres columnas
  NULLABLE y un CHECK (`NOT VALID` + `VALIDATE`). Las recetas anteriores quedan
  con NULL y su hash se sigue calculando con el formato v1 (test de regresión
  con el valor de DX-013 en `prescription-hash.spec.ts`).

## Imputación de abonos a ítems (DX-051)

Cada abono a un plan se reparte entre los ítems `DONE` y `ACCEPTED` del plan
(primero los realizados, el abono más antiguo primero; nunca a `PROPOSED`) y
`GET /treatment-plans/:id/balance` devuelve el cobrado y el pendiente de cada
ítem. Un ADMIN puede fijar un abono a mano con `PUT /payments/:id/allocations`.
Los totales (saldo del plan, estado de cuenta, caja, cartera, recibos) **no**
leen las imputaciones: se calculan como antes.

- **Tablas** (RLS FORCE las cuatro): `payment_plan_amounts` (la base del abono
  en la moneda del plan, convertida con la tasa de su día), `payment_allocations`
  (la imputación vigente), `plan_allocation_rebalance_requests` (cola de
  solo-inserción de planes por repartir) y `payment_allocation_movements`
  (historial por trigger con su causa: `AUTO`, `MANUAL`, `RELEASE`, `VOID`).
- **Reparto**: lo encola la escritura que lo provoca (un trigger o el alta del
  abono) y lo hace `DrainAllocationRebalancesInterceptor` al terminar la
  petición, o el barrido `payment-allocations.sweep` (cada minuto, clínica por
  clínica: crea las bases que faltan y drena la cola). Un abono sin tasa no se
  imputa y cuenta en `unconvertedPaymentsCount` hasta que la haya.

### Despliegue: backfill de los abonos anteriores

Los abonos cobrados antes de esta función no tienen base ni imputación. Tras
`prisma migrate deploy`, una vez por entorno:

```bash
npm run allocations:backfill -- --dry-run              # cuenta, no escribe
npm run allocations:backfill                           # todas las clínicas
npm run allocations:backfill -- --tenant <uuid>        # una clínica
```

- **Córrelo solo cuando ya no quede ninguna réplica anterior a DX-051.** Una
  réplica antigua que anule un abono no borra sus imputaciones (R12 vive en el
  código nuevo). El backfill las limpia (`voidedCleaned`, con los bloqueos y la
  causa `VOID` de la anulación) y reparte de nuevo lo liberado, pero solo si se
  corre después de la última réplica antigua: despliega con parada única o
  retira las viejas antes. No tiene efecto con `--dry-run`.
- El barrido de cada minuto también crea bases (hasta 50 abonos por clínica y
  pasada), así que el backfill solo acelera ese trabajo y lo cubre de una vez.
- Corre con el rol de la app (`DATABASE_URL`, RLS FORCE), clínica por clínica,
  nunca como superusuario ni con la conexión del owner.
- Por clínica crea la base de cada abono vivo a un plan sin base (`manual =
  false`) y reparte cada plan con la misma regla automática. Un abono sin tasa
  se cuenta como `withoutRate` y no frena nada: el barrido le crea la base en
  cuanto la haya.
- **Idempotente y re-ejecutable**: no recrea bases ni toca imputaciones (el
  reparto solo llena sobrantes, y respeta los abonos fijados a mano). Una
  segunda pasada informa `basesCreated: 0` y `allocatedCents: 0`.
- Imprime una línea JSON por clínica, solo con números: `basesCreated`,
  `withoutRate`, `plansRebalanced`, `allocatedCents` (y `voidedCleaned`). Con `--dry-run`,
  `basesCreated` son las que se crearían y el reparto solo se calcula sobre las
  bases que ya existen (las que aún no existen no se imputan hasta la pasada
  real).
- Convertir puede **escribir en la caché `exchange_rate_snapshots`** (una
  llamada al proveedor por fecha que falte) aun en `--dry-run`. Para abonos de
  fechas antiguas conviene precargar las tasas antes de la pasada real, o la
  primera tardará lo que tarde el proveedor.
- `npm run seed:demo` ya deja la demo imputada (un abono fijado a mano y un
  plan con importe sin imputar) y con la cola vacía.

### Migraciones de datos futuras

Un trigger de `treatment_plan_items` (`price`, `discount`, `status`,
`deletedAt`, `completedAt`) y otro de `treatment_plans` (`status`, `deletedAt`)
liberan imputaciones y encolan el plan. Si fallan sin tenant en la sesión
(`insufficient_privilege`, «Falta el tenant de la sesión (DX-051)»), es a
propósito: con RLS FORCE y sin clínica fijada la liberación borraría 0 filas en
silencio. Una migración del owner que cambie esas columnas debe **fijar la
clínica** en su transacción, clínica por clínica
(`SELECT set_config('app.current_tenant', '<uuid>', true)`); es la única
opción probada (`test/owner-nosu/payment-allocations-guc.owner-spec.ts`). **No
basta con quitar FORCE de `payment_allocations`**: los mismos triggers insertan
además en `plan_allocation_rebalance_requests` y en
`payment_allocation_movements`, que siguen con FORCE, y la migración fallaría
con «new row violates row-level security policy». Quitar FORCE de las tres
tablas (y restaurarlo después, con `npm run db:check-force`) no está probado;
mejor fijar la clínica. Esta guía sustituye al comentario antiguo de la
migración `20261026100300_dx051_payment_allocations` («una migración con NO
FORCE no se ve afectado»), que quedó incompleto y no se corrige en el fichero
porque la migración ya está aplicada.

### Abonos sin base: reintento escalonado y lista de trabajo (DX-380)

Antes, el barrido recorría todas las clínicas cada minuto, buscaba los abonos
sin base con un Seq Scan de `payments` (DB-056) y reintentaba los mismos 50
(los más recientes) para siempre, con una llamada al proveedor por cada día
sin snapshot (OPS-045). Ahora:

- **Lista de trabajo** `payment_base_retries` (RLS FORCE, FK compuesta
  `("tenantId", "paymentId")` → `payments("tenantId", "id")`, índice único
  nuevo `payments_tenant_id_key`): una fila por abono vivo que espera su tasa
  o, si es a un plan vivo, su base. La crea el trigger DIFERIDO
  `payments_base_retry_enroll` al confirmar el alta (también la de una
  réplica anterior) y la borra el barrido cuando el abono ya tiene las dos.
  Columnas: `attempts`, `nextAttemptAt`, `lastReason` (`NO_RATE`: sin tasa,
  también el proveedor caído, por tiempo agotado o sin presupuesto;
  `ERROR`: otro fallo) y `createdAt` (desde cuándo espera).
- **Selección** por clínica: `"nextAttemptAt" <= now() ORDER BY
  "nextAttemptAt"` (índice `payment_base_retries_due_idx`), hasta 50. Un
  intento fallido se aplaza **1 min → 5 → 30 → 2 h → 24 h** (tope) desde la
  hora de la BD: un abono atascado va al final y no tapa a los resolubles.
- **Solo las clínicas con pendientes**: `dx_payment_allocation_sweep_tenants()`
  (SECURITY INVOKER, fija el tenant de cada clínica para respetar la RLS)
  devuelve, en una sentencia, las clínicas vivas con un reintento vencido o un
  plan por repartir. Las demás no abren transacción.
- **Adelantar el reintento**: registrar o corregir una tasa manual y cambiar
  la fuente (`ExchangeSourceChangeHooks.afterRatesChange`) ponen ya los
  reintentos aplazados de la clínica: el barrido siguiente los intenta.
- **Proveedor** (SEC-054, ya hecho): el `fetch` se corta a los 10 s y el
  fallo es «sin tasa»; la caché negativa (1 h, `EXCHANGE_NEGATIVE_CACHE_TTL_MS`)
  y el single-flight dejan **una llamada por día y réplica** con el proveedor
  caído, aunque lo pidan N clínicas; con fuente MANUAL no se llama nunca por
  los días de su tasa manual.
- **Aviso al ADMIN**: `GET /payments/rate-backlog` (solo ADMIN, 403 en
  español al resto) da `{ count, oldestSince }` de los abonos vivos que llevan
  más de 24 h pendientes; la web lo enseña en el panel («N abonos sin tasa
  desde el …») con enlace a Ajustes › Tasa de cambio. Sin datos del abono ni
  del paciente.
- **Logs**: `payments.allocation_retry_failed` (`paymentId`, `attempts`, tipo
  de error) y `payments.allocation_retries_failed` (`tenantId`); nunca
  importes ni nombres.
- **Migraciones** (aditivas): `20261104120200_dx380_payments_tenant_id_key`
  (CONCURRENTLY), `20261104120300_dx380_payment_base_retries` (tabla, RLS,
  trigger y funciones; `lock_timeout` 5 s) y
  `20261104120400_dx380_payment_base_retries_backfill` (los abonos que ya
  esperaban, por lotes de 2.000 y clínica; entran en la primera pasada).
  Una réplica anterior sigue con su barrido de siempre (todas las clínicas)
  durante el despliegue. Después, `npm run db:check-force`.

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

DX-236: `dentalix_app` solo tiene `SELECT` en las referencias globales
`icd10_codes`, `currencies`, `countries` y `cities`. La migración revoca
`INSERT`, `UPDATE`, `DELETE` y `TRUNCATE`; repetir `create-app-role.sql`
conserva esta restricción. `exchange_rate_snapshots` sigue siendo escribible.
Si la migración avisa que no puede revocar o quedan permisos heredados, un
admin debe corregir los grants y ejecutar `npm run db:check-force` antes de
arrancar la API; `reference_writes` identifica tabla y privilegio efectivos.

Cada diagnóstico guarda `clinical_entry_diagnoses."labelEs"`, copiada por
un trigger al insertar aunque el cliente mande otro texto. Ficha y DTO leen
esa copia. El backfill
único usa el texto disponible al migrar: no reconstruye etiquetas históricas.
Se ejecuta en transacción explícita y bajo bloqueo exclusivo, suspende solo
el trigger de UPDATE y FORCE de esa tabla, y restaura ambos antes del COMMIT;
un fallo revierte todos los cambios, también con owner sin superusuario.
La siembra CIE-10 añade códigos nuevos y conserva todas las etiquetas ya
existentes, incluso las de códigos sin uso. Sus correcciones requieren una
migración explícita con el owner; nunca reescriben la copia clínica guardada.

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
#                    sin la política restrictiva `"tenantId" IS NULL` (DX-144);
#      timezone      dentalix_app no arranca con TimeZone = UTC (DX-226), con
#                    un `message` en español que dice cómo arreglarlo.
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

- **Zona horaria: UTC** (DX-226). Las columnas de hora son `timestamp` sin
  zona: Prisma graba en UTC desde la API y los triggers que ponen la hora del
  servidor (historia clínica, implantes, gestiones y compromisos de cobro,
  recibos, alta de los abonos, resumen de la cartera y, con
  `20261019090100_dx226_cash_sessions_server_time_utc`, apertura, cierre,
  reapertura y ajustes de la caja por turno) graban
  `timezone('UTC', now())`; `test/server-time-utc.int-spec.ts` falla si una
  función de `public` vuelve a usar `CURRENT_TIMESTAMP` o `now()` sin UTC. Aun así, `dentalix_app` (y el owner, y los roles
  NOLOGIN) tiene que arrancar con `TimeZone = UTC`: cualquier hora que la BD
  calcule con la zona de la sesión (`CURRENT_TIMESTAMP` en un `DEFAULT`, SQL
  a mano, un trigger futuro) se desfasaría (con `America/Bogota`, 5 h). La
  migración `20261019090000_dx226_server_time_utc_receipt_series` hace
  `ALTER ROLE … SET timezone = 'UTC'` en `dentalix_app`, el dueño de la base,
  `dentalix_owner` y los roles NOLOGIN, y `ALTER DATABASE <base> SET timezone
  = 'UTC'`. El owner sin superusuario puede con la base (es su dueño) y con
  los roles que creó (ADMIN); si no puede con alguno (p. ej. un rol
  superusuario creado por el admin), la migración deja un `WARNING` y sigue:
  la base ya queda en UTC y cubre a cualquier rol sin valor propio. Si un rol
  tiene otra zona fijada (`ALTER ROLE … SET timezone` o `ALTER ROLE … IN
  DATABASE`), gana sobre la de la base y `db:check-force` sale con 1 en
  `timezone`; arréglalo como admin o como el owner
  (`ALTER ROLE dentalix_app SET timezone = 'UTC'`, o `RESET timezone` en el
  `IN DATABASE`). Solo afecta a sesiones nuevas: reinicia las réplicas de la
  API tras cambiarlo. `db:check-force` mira el catálogo (rol + base, rol,
  base, por ese orden; sin ninguna también falla) y, si `DATABASE_URL` es de
  `dentalix_app`, el `SHOW TimeZone` de una sesión real. Las horas ya
  grabadas no se reescriben; las columnas no pasan a `timestamptz`.
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
- **Rellenos grandes por lotes, sin `NO FORCE` ni ACCESS EXCLUSIVE** (DX-225,
  DB-029): `NO FORCE` toma ACCESS EXCLUSIVE sobre la tabla hasta el COMMIT,
  así que un relleno de una tabla grande y caliente bajo él bloquea hasta las
  lecturas. Para esos, separa el esquema (`ADD COLUMN` sin `DEFAULT` y, si la
  columna la mantiene la BD, el trigger que la calcula en las filas nuevas)
  del relleno, en una migración propia de **una sola sentencia `DO`** que
  recorre las clínicas, fija `set_config('app.current_tenant', …, true)` y
  hace `COMMIT` tras cada lote (`prisma migrate deploy` la ejecuta fuera de un
  bloque de transacción, como un `CREATE INDEX CONCURRENTLY`). Con la clínica
  fijada, la RLS del owner sin superusuario deja ver y escribir sus filas, y
  cada lote solo retiene bloqueos de fila hasta su COMMIT. Idempotente (`WHERE
  <columna> IS NULL`) para poder repetirla si se corta. Después, el índice
  `CONCURRENTLY` en otro fichero. Modelo:
  `20261020100100…100400_dx225_patients_phone_tail*`, con su tramo en
  `test/owner-nosu/migrations-data.owner-spec.ts`; y
  `20261024100000…100300_dx287_patients_doc_key*`, que además recorre por
  cursor (`id > último`, nunca `ORDER BY … LIMIT` sobre lo pendiente) y
  termina con un `ANALYZE` de la columna (SHARE UPDATE EXCLUSIVE). Una
  columna `GENERATED … STORED` nueva reescribe la tabla bajo ACCESS
  EXCLUSIVE: en `patients`, 1,4 s con 65k pacientes (DX-287), así que ahí
  va por trigger.
- **Políticas con `NULLIF`: `app.current_tenant` puede llegar vacío**
  (DX-251, OPS-037): tras una transacción con `set_config(…, true)` la
  variable no vuelve a NULL, queda en `''` el resto de la sesión, y `migrate
  deploy` aplica todas las migraciones en una sola sesión. Con
  `current_setting('app.current_tenant', true)::uuid` la política lanzaba
  22P02 (`''::uuid`) en la siguiente migración que leyera una tabla con FORCE
  (la FK de `patient_documents` hacia `patients`, tras el relleno de DX-225).
  Toda política y todo SQL de migración nuevo escribe
  `"tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid`:
  con la variable vacía compara con NULL y **niega** la fila, igual que sin
  clínica fijada. `20261020200050_dx251_rls_tenant_guc_nullif` y
  `…230000_…_rest` reescribieron las existentes (y la función de las
  particiones de `audit_events`) sin editar migraciones aplicadas. Lo vigilan
  el lint `test/migrations/tenant-guc-nullif.spec.ts`,
  `test/rls-catalog.int-spec.ts` (forma exacta), `test/rls-empty-tenant-guc.int-spec.ts`
  (0 filas y sin error con la variable vacía) y
  `test/owner-nosu/tenant-guc-empty.owner-spec.ts` (la FK se valida en esa
  sesión con el owner sin superusuario).
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
  `docker run -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:16`, o sin
  Docker `initdb` + `pg_ctl -o '-p 55432'` de PostgreSQL 16 como el usuario
  `postgres`): crea
  el owner y la base como en el paso 1, aplica los pasos 2 a 4, y
  `DIRECT_URL=<owner> DATABASE_URL=<app> OWNER_NOSU_ADMIN_URL=<admin>/postgres
  npm run test:owner-nosu`. Los specs crean y borran sus propias bases y, el
  de clúster compartido, un segundo owner y un intruso con nombre único.

## Lint en local sin agotar memoria (DX-338)

```bash
npm run lint:check        # lo mismo que CI: comprueba, no reescribe
npm run lint              # con --fix
```

Las reglas son *type-aware* (`projectService`): ESLint carga el programa de
TypeScript entero de `tsconfig.json` (`src/`, `test/` y `prisma/`; nunca
`dist/` ni `coverage/`). Con el arreglo de DX-338 el `lint:check` completo
cabe en un heap de 2 GB (`--max-old-space-size=2048`: 2,2 GB de memoria
máxima medida con `/usr/bin/time -v`; sin límite Node recoge basura más tarde
y llega a 3–3,7 GB). Antes pasaba de 4 GB de heap (5,6 GB de memoria) y en CI
moría con exit 134. El límite por defecto de Node basta en una máquina de
8 GB o más. Si aun así muere (`Killed`, exit 134,
`JavaScript heap out of memory`):

```bash
# subir el heap de Node solo para el lint
NODE_OPTIONS=--max-old-space-size=4096 npm run lint:check
# o lintar por partes (cada una carga menos ficheros)
npx eslint "src/**/*.ts"
npx eslint "test/**/*.ts"
# ver la memoria máxima y el tiempo (GNU time)
/usr/bin/time -v npm run lint:check
```

La causa que había (y que vigila la propia configuración): un
`new PrismaClient({ datasources: … })` sin argumento de tipo infiere un
`PrismaClient<{ datasources: … }>` distinto en cada fichero, y pasarlo donde
se espera `PrismaClient` (`resetDatabase(raw)`, `seed…(raw)`) obliga a
TypeScript a comparar el cliente entero, con sus 100+ modelos. Con ~250
clientes así en `test/` y `prisma/` el programa tenía 3,8 M de tipos y tsc
usaba 4,2 GB. Por eso se escribe `new PrismaClient<Prisma.PrismaClientOptions>({
… })`, que es exactamente el `PrismaClient` por defecto; `no-restricted-syntax`
lo exige en todo el repo (la excepción legítima, inferir `log` por eventos para
usar `$on`, va con `eslint-disable-next-line` y el motivo).

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

**Limpieza entre ficheros e2e/int (DX-251).** Cada `*.e2e-spec.ts` /
`*.int-spec.ts` limpia con `await resetDatabase(raw)`
(`test/support/e2e-fixtures.ts`: `TRUNCATE … CASCADE` de todas las tablas de
datos), nunca con `raw.<modelo>.deleteMany()` sin `where` sobre una tabla con
hijos: choca con la FK si otro spec dejó filas hijas (p. ej. citas) y tumba el
fichero según el orden. Lo vigila el unit `test/invariants/bare-delete-many.spec.ts`.
Para borrar solo unas clínicas (la demo, o las de un spec que no vacía la base)
se usa `purgeTenants(raw, ids)` (`test/support/tenant-purge.ts`, DX-396): lee
de `pg_constraint` las tablas de clínica (FK a `tenants` o columna `tenantId`)
y las borra hijas primero, también tras las tablas que llenan los triggers de
DELETE de otras. Una tabla nueva entra sola; si no puede (referencia a una de
clínica sin tener `tenantId`) o hay un ciclo, falla nombrando la tabla. Lo
vigila `test/tenant-purge.int-spec.ts`; y el unit
`test/invariants/e2e-tenant-purge.spec.ts`, que ningún e2e borre `tenants` a
mano (el registro por la API siembra filas propias, como los medios de pago).

**CI.** `lint` va en su propio job (con `NODE_OPTIONS=--max-old-space-size=4096`,
su memoria máxima con `/usr/bin/time -v` y las reglas más lentas con
`TIMING=1` en el log) y tipos, unit y build en otro, con cada paso
`if: ${{ !cancelled() }}`: un rojo del lint o de tsc ya no deja los demás
`skipped` (DX-338). `integration` y `e2e` son jobs separados (cada uno con su Postgres 16 y
su MinIO): un rojo en `test:int` no oculta la e2e. La e2e va repartida en 3
shards (`jest --shard=i/3`, matriz `shard`/`total`/`timeout` del job `e2e`,
tope de 20 min por shard, DX-396): cada shard publica su duración en el
resumen de la run y emite un `::warning::` al pasar del 70 % del tope
(`.github/scripts/report-job-duration.sh`), y el job `e2e-shards` comprueba
que la unión de las listas de los shards es `jest --listTests` completo sin
repetidos (`.github/scripts/check-e2e-shards.sh`). Si un shard se acerca al
tope, se sube `total` y se añade el número a `shard`. El MinIO de prueba es
`cgr.dev/chainguard/minio` fijado por digest en `.github/scripts/start-test-s3.sh`
y `docker-compose.yml` (`minio/minio` ya no se puede descargar de Docker Hub);
si la imagen no se descarga, el paso queda en rojo con un error que lo dice y
el resto de la suite sigue corriendo.

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
