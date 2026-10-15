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

# production mode
$ npm run start:prod
```

## Local setup

1. Instalar dependencias:
   ```bash
   npm install
   ```
2. Configurar variables de entorno (`.env`, ver `.env.test` para el entorno de tests) con `DATABASE_URL`/`DIRECT_URL` apuntando a Postgres.
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
   sus estados, abonos en COP de los últimos 60 días en ambas sedes, un plan de
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
