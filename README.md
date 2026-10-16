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
   evoluciones y odontograma, ~90 citas desde el lunes de la semana pasada hasta
   el sábado de la próxima en distintos estados, planes de tratamiento en todos
   sus estados (con un presupuesto en borrador con descuentos, listo para
   presentar, y otro aceptado con la firma del paciente — DX-012), abonos en COP de los últimos 60 días en ambas sedes, un plan de
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
