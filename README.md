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
   registro; "Sede Norte" con el suyo), catálogo por defecto con tarifas en COP,
   25 pacientes ficticios (correos `@example.com`) con historias clínicas,
   evoluciones (una corregida con una adenda — DX-038; tres con diagnóstico CIE-10, CUPS en seis procedimientos y REPS en la sede principal para ver «RDA: listo» — DX-212) y odontograma (un hallazgo anulado con motivo y una paciente infantil con dentición mixta, registros temporales y de otro origen — DX-120), 5 tipos de cita con duración y color (DX-121), las 6 plantillas de evolución de ejemplo con dos evoluciones redactadas con ellas («Resina» y «Profilaxis») y ligadas a las últimas citas atendidas (DX-170), las 5 indicaciones postoperatorias de ejemplo con `POI-EXO` vinculada a «Exodoncia simple», la sede principal con teléfono y una entrega impresa de ayer (o del último día con consulta) — DX-222, ~90 citas desde el lunes de la semana pasada hasta
   el sábado de la próxima en distintos estados (las de valoración, limpieza, endodoncia, urgencia y ortodoncia con su tipo), bloqueos de agenda (vacaciones de la segunda dentista de lunes a viernes de la semana siguiente a la próxima, en todas las sedes, y el almuerzo del equipo en la sede principal el próximo día laborable, que deja agendar con aviso) y 3 «Pendientes por agendar» abiertos (las dos cancelaciones o no-shows más recientes y un alta manual urgente; las más antiguas quedan descartadas con motivo) — DX-122, y la cita agendada más lejana de la primera dentista en la sede principal marcada «Adelantar si hay hueco», que sale como candidata en «Ocupar este hueco» al cancelar una cita anterior (DX-210), planes de tratamiento en todos
   sus estados (con un presupuesto en borrador con descuentos —uno del 10 % del
   odontólogo y otro del 15 % de la administración con su motivo, que salen en
   el informe de descuentos (DX-204)—, listo para presentar, y otro aceptado con la firma del paciente — DX-012; y dos opciones A/B de Carolina Duque —implante o puente— presentadas hace 9 días y sin cita futura, que salen en «Presupuestos por seguir» — DX-040), abonos en COP de los últimos 60 días en ambas sedes, cada uno con su recibo de caja numerado por sede (`PRI-000001`…, `NOR-000001`…; el abono duplicado anulado conserva su número y sale «ANULADO» — DX-136), un plan de
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
- **Estado del plan en la transacción (BE-036)**: alta, edición y bloque
  bloquean la fila del plan (FOR SHARE; el ítem, FOR UPDATE), la releen y solo
  entonces validan si está aceptado, firmado o cerrado. Una aceptación sin
  firma que confirma mientras una edición espera ya no deja cambiar el plan
  aceptado (`test/plan-item-accept-race.int-spec.ts`).

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

## Códigos para el RDA: CIE-10, CUPS y REPS (DX-212)

Datos que pide el Resumen Digital de Atención (Res. 1888/2025, Colombia) y el
RIPS. Esta tarea solo los guarda y COMPRUEBA: no genera el Bundle FHIR ni envía
nada al Ministerio.

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
- **CUPS** (`dental_catalog_items.cupsCode`, 6 alfanuméricos) y **REPS**
  (`locations.repsHabilitationCode`, 12 dígitos): en `PATCH /catalog/items/:id`
  y `PATCH /locations/:id`, solo ADMIN, con CHECK en la BD y 400 que dice el
  formato. Vacío o `null` lo quita. Altas y cambios del catálogo y cambios de
  sede quedan en `audit_events` (`DENTAL_CATALOG_ITEM`, `LOCATION`, con los
  campos cambiados, nunca los valores).
- **`GET /clinical-entries/:id/rda-readiness`** (roles clínicos; recepción no
  ve diagnósticos) → `{ notApplicable, ready, missing[], pending[] }`. Sede: la
  de la cita ligada o, sin cita, la principal (la evolución no guarda sede).
  Fuera de Colombia, `notApplicable: true`. Comprueba documento del paciente,
  diagnóstico principal, CUPS de los procedimientos hechos en esa atención
  (odontograma: `PROCEDURE` `COMPLETED` de esta clínica, ligados a la evolución
  o del mismo día civil en la zona de la sede, sin los anulados), REPS de la
  sede y registro profesional del autor. El NIT va en `pending` («pendiente de
  DX-019») y no cuenta para `ready`. Evolución de otra clínica: 404. Queda
  auditado (`VIEW`, `RDA_READINESS`, con el paciente).
- **Demo**: CUPS en seis procedimientos (ejemplos: verifícalos contra la tabla
  oficial), REPS en la sede principal (la Norte sin él) y diagnósticos en tres
  evoluciones; la de Ana (hace 40 días) sale «RDA: listo».

## Registro de implantes (DX-191)

Ficha de cada implante, pilar, injerto o membrana colocado (Res. 4816/2008
art. 31 en CO; Reglamento (UE) 2017/745 art. 18 y RD 192/2023 art. 36 en ES),
módulo `src/modules/implants`, tabla `patient_implants`.

- **Alta** `POST /patients/:id/implants` (DENTIST y ADMIN; el resto 403 en
  español): diente FDI (el mismo validador que el odontograma, con
  temporales), tipo `IMPLANT|ABUTMENT|GRAFT|MEMBRANE|OTHER`, fabricante,
  sistema, referencia (REF), lote, UDI, diámetro × longitud, registro
  sanitario (INVIMA/CE), notas, fecha de colocación (por defecto hoy en la
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
  | `schedules[]` | Por tarea: `cron`, `lastRunAt`, `nextRunAt`, `periodMs`, `delayMs` y `overdue` (más de **2 periodos** sin correr, o sin sincronizar: `nextRunAt` null) |

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

  | Tarea | Cron (UTC) | Qué hace |
  |-------|------------|----------|
  | `auth.purge-expired-tokens.hourly` | `17 * * * *` | Borra `revoked_tokens` y `pending_registrations` vencidos y `user_tokens` caducados/usados hace > 7 días. Sustituye a la limpieza lazy de cada logout/refresh |
  | `email.purge-outbox.daily` | `23 4 * * *` | Borra de `email_outbox` los SENT/FAILED de más de `MAIL_OUTBOX_RETENTION_DAYS` (90), clínica a clínica bajo su RLS, y los de plataforma por `email_outbox_purge_platform` (DX-144) |
  | `exchange.prefetch-rates.daily` | `5 0 * * *` | Precarga los tipos de cambio del día UTC (si hay `EXCHANGE_APP_ID`); la petición conserva el `fetch` como respaldo |
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
  con el país de la sede activa o la principal (`whatsapp-phone.ts` + forma de
  móvil de CO/ES); uno inválido se guarda con aviso, pero no puede ser canal
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
  (CO < 18, ES < 16 —menor maduro, Ley 41/2002—, con el país y el día civil
  de la sede) o SIN email recibe el recordatorio (DX-026), el recibo (DX-136)
  y el estado de cuenta (DX-011) en el email de su responsable que recibe
  avisos, primero el pagador. El canal y la baja del PACIENTE (DX-128) se
  respetan igual; en el recordatorio automático, tampoco recibe un paciente
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
  la falta de email o de teléfono con indicativo dan 422 en español sin
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
  `GET|POST /patients/:patientId/coverages`, `PATCH|DELETE …/:coverageId`.
  `GET /patients/:id`, `GET /patients` y `GET /appointments` traen `coverage`
  (resumen de la principal viva, sin nº de afiliado; un número fijo de
  consultas por página). `GET /patients?payerId=` filtra por pagador.
- **Roles**: leer pagadores, los 4 roles; crearlos, ADMIN y recepción;
  editar, desactivar y retirar, ADMIN. Las coberturas las gestionan los 4
  roles, como «Editar» de la ficha (son datos administrativos, no clínicos).
- **Auditoría**: las coberturas escriben UPDATE de PATIENT con `reason`
  `COVERAGE_ADDED|CHANGED|REMOVED`; la metadata solo lleva los nombres de los
  campos, nunca el nº de afiliado ni el titular. El catálogo de pagadores no
  se audita. El GET de coberturas tampoco (la ficha ya se audita).
- **Relleno**: la migración `…_insurer_eps_backfill` crea un pagador por
  clínica y texto normalizado (tipo OTRO, sin país; el ADMIN lo reclasifica) y
  una cobertura principal por paciente con `insurerEps` no vacío, marcada
  `migratedFromInsurerEps`. Es idempotente, incluye archivados y no toca
  `insurerEps`, que queda DEPRECADO y de solo lectura: la API ya no lo
  escribe y un cliente antiguo que lo mande no da error.
- **Demo**: `npm run seed:demo` crea 7 pagadores (Sura EPS, Sanitas,
  Compensar, Nueva EPS, Famisanar, Salud Total, Coomeva) y una cobertura
  principal por paciente que tenía aseguradora, con una vencida y una
  pendiente para ver los tres estados. El seed omite una clínica demo ya creada.
- **Tests**: `payers.e2e-spec.ts`, `patient-coverages.e2e-spec.ts`,
  `appointments-coverage.e2e-spec.ts`, `patient-coverages.int-spec.ts` (RLS,
  FK compuestas, relleno) y los recuentos de `seed-demo.int-spec.ts`.

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

**Subida de avatares**: PNG, JPEG o WebP de hasta 2 MB. Se comprueba la
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
  `test/owner-nosu/migrations-data.owner-spec.ts`.
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
