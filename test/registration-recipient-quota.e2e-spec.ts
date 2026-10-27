import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { CapturingMailer } from './support/capture-mailer';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  loadMailConfig,
  MAIL_CONFIG,
} from '../src/modules/notifications/email/infrastructure/mail-config';
import { EmailPayloadCipher } from '../src/modules/notifications/email/infrastructure/email-payload-cipher';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import {
  REGIONAL_BOGOTA_FIXTURE,
  registerBody,
} from './support/location-fixtures';

// DX-144 (SEC-034): `POST /auth/register` ya no es un relé de emails. Con los
// topes reales de plataforma (1 cada 10 min y 3 en 24 h al mismo
// destinatario, contados en la BD por su hash), diez altas seguidas con el
// mismo email producen un solo email, todas reciben el MISMO 202 y un alta
// repetida dentro del enfriamiento no invalida el enlace de la primera.
//
// Las peticiones llevan X-Forwarded-For distintos para dejar claro que el
// tope no es por IP (con TRUST_PROXY=false la API ni siquiera los mira: el
// balde por IP lo suben los e2e en setup-e2e.ts).

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DOMAIN = '@dx144.test';
const RUN = randomBytes(4).toString('hex');
const SUB_PREFIX = `dx144-${RUN}`;
const VERIFY_LINK = /\/register\/verificar\/([A-Za-z0-9_-]{43})/;
const COOLDOWN_MS = 600_000;

const settle = () => new Promise((resolve) => setTimeout(resolve, 1500));

describe('Registro sin relé de emails (e2e, DX-144)', () => {
  let app: INestApplication<App>;
  const mailer = new CapturingMailer();
  let hashOf: (email: string) => string;
  const emails: string[] = [];

  const http = () => request(app.getHttpServer());
  const register = (
    email: string,
    i: number,
    overrides: Partial<{ subdomain: string; password: string }> = {},
  ) =>
    http()
      .post('/api/v1/auth/register')
      .set('X-Tenant-Host', 'localhost')
      .set('X-Forwarded-For', `198.51.100.${i + 1}`)
      .send(
        registerBody(REGIONAL_BOGOTA_FIXTURE, {
          clinicName: 'Clínica Sonda',
          subdomain: overrides.subdomain ?? `${SUB_PREFIX}-${i}`,
          email,
          password: overrides.password ?? `Clave-${i}-Dx144!`,
          fullName: 'Quien Sea',
        }),
      );

  /** Simula que pasó el tiempo para ese destinatario (emails y pendiente). */
  async function age(email: string, ms: number): Promise<void> {
    const toHash = hashOf(email);
    await raw.$executeRaw`
      UPDATE "email_outbox"
         SET "createdAt" = "createdAt" - make_interval(secs => ${ms / 1000}::float8)
       WHERE "tenantId" IS NULL AND "toHash" = ${toHash}`;
    await raw.$executeRaw`
      UPDATE "pending_registrations"
         SET "createdAt" = "createdAt" - make_interval(secs => ${ms / 1000}::float8)
       WHERE "email" = ${email}`;
  }

  const sentTo = (email: string) => mailer.sent.filter((m) => m.to === email);

  async function cleanup(): Promise<void> {
    if (hashOf) {
      await raw.emailOutbox.deleteMany({
        where: { tenantId: null, toHash: { in: emails.map(hashOf) } },
      });
    }
    await raw.clinicMembership.deleteMany({
      where: { tenant: { subdomain: { startsWith: SUB_PREFIX } } },
    });
    await raw.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await raw.pendingRegistration.deleteMany({
      where: { email: { endsWith: DOMAIN } },
    });
    await raw.tenant.deleteMany({
      where: { subdomain: { startsWith: SUB_PREFIX } },
    });
  }

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(mailer);
        // Los topes de plataforma de producción (setup-e2e.ts los apaga
        // para el resto de suites, que se registran sin parar).
        builder.overrideProvider(MAIL_CONFIG).useValue({
          ...loadMailConfig((key) => process.env[key]),
          platformQuotas: {
            recipientCooldownSeconds: COOLDOWN_MS / 1000,
            recipientDaily: 3,
          },
        });
      },
    });
    const cipher = app.get(EmailPayloadCipher, { strict: false });
    hashOf = (email: string) => cipher.hashRecipient(email);
  });

  afterAll(async () => {
    await app.get(EmailDispatcher, { strict: false }).whenIdle();
    await app.close();
    await cleanup();
    await raw.$disconnect();
  });

  it('diez altas seguidas con el mismo email nuevo: un email en el enfriamiento, tres en 24 h, y siempre el mismo 202', async () => {
    const email = `rafaga-${RUN}${DOMAIN}`;
    emails.push(email);

    const first = await register(email, 0);
    expect(first.status).toBe(202);
    const [, token] = await mailer.waitFor(email, VERIFY_LINK);

    const burst = await Promise.all(
      Array.from({ length: 9 }, (_, i) => register(email, i + 1)),
    );
    await settle();
    await app.get(EmailDispatcher, { strict: false }).whenIdle();

    for (const res of burst) {
      expect(res.status).toBe(202);
      expect(res.body).toEqual(first.body);
    }
    expect(Object.keys(first.body as object)).toEqual(['message']);
    expect(sentTo(email)).toHaveLength(1);
    expect(
      await raw.emailOutbox.count({
        where: { tenantId: null, toHash: hashOf(email) },
      }),
    ).toBe(1);

    // El enlace del primer email sigue valiendo con la contraseña del primero:
    // las nueve altas siguientes no reemplazaron el pendiente.
    const pending = await raw.pendingRegistration.findUniqueOrThrow({
      where: { email },
    });
    expect(pending.subdomain).toBe(`${SUB_PREFIX}-0`);
    expect(token).toHaveLength(43);

    // Pasado el enfriamiento entra otro, y otro, hasta 3 en 24 h.
    const later: request.Response[] = [];
    for (let i = 0; i < 3; i++) {
      await age(email, COOLDOWN_MS + 1000);
      later.push(await register(email, 10 + i));
      await settle();
      await app.get(EmailDispatcher, { strict: false }).whenIdle();
    }
    for (const res of later) {
      expect(res.status).toBe(202);
      expect(res.body).toEqual(first.body);
    }
    expect(sentTo(email)).toHaveLength(3);
    expect(
      await raw.emailOutbox.count({
        where: { tenantId: null, toHash: hashOf(email) },
      }),
    ).toBe(3);
  });

  it('un email ya registrado tampoco recibe más avisos que el tope', async () => {
    const email = `titular-${RUN}${DOMAIN}`;
    emails.push(email);
    await raw.user.create({
      data: { email, passwordHash: 'x', fullName: 'Titular DX-144' },
    });

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) => register(email, 20 + i)),
    );
    await settle();
    await app.get(EmailDispatcher, { strict: false }).whenIdle();

    const fresh = await register(`otro-${RUN}${DOMAIN}`, 30);
    emails.push(`otro-${RUN}${DOMAIN}`);
    for (const res of responses) {
      expect(res.status).toBe(202);
      expect(res.body).toEqual(fresh.body);
    }
    expect(sentTo(email)).toHaveLength(1);
    expect(sentTo(email)[0].text).toMatch(/Alguien intentó registrar/);
  });

  it('un segundo registro dentro del enfriamiento no invalida el enlace del primero', async () => {
    const email = `doble-${RUN}${DOMAIN}`;
    emails.push(email);
    const password = 'Clave-Primera-Dx144!';

    const first = await register(email, 40, {
      subdomain: `${SUB_PREFIX}-primera`,
      password,
    });
    const [, token] = await mailer.waitFor(email, VERIFY_LINK);
    const second = await register(email, 41, {
      subdomain: `${SUB_PREFIX}-segunda`,
      password: 'Clave-Segunda-Dx144!',
    });
    await settle();
    await app.get(EmailDispatcher, { strict: false }).whenIdle();

    expect(second.status).toBe(202);
    expect(second.body).toEqual(first.body);
    expect(sentTo(email)).toHaveLength(1);

    const verified = await http()
      .post('/api/v1/auth/register/verify')
      .send({ token, password })
      .expect(201);
    expect(verified.body).toMatchObject({ subdomain: `${SUB_PREFIX}-primera` });
  });

  it('el email de verificación no lleva el nombre que escribió el solicitante', async () => {
    const email = `saludo-${RUN}${DOMAIN}`;
    emails.push(email);
    await http()
      .post('/api/v1/auth/register')
      .set('X-Tenant-Host', 'localhost')
      .send(
        registerBody(REGIONAL_BOGOTA_FIXTURE, {
          clinicName: 'Clínica Sonda',
          subdomain: `${SUB_PREFIX}-saludo`,
          email,
          password: 'Clave-Saludo-Dx144!',
          fullName: 'Tu banco bloqueó tu cuenta llama ya',
        }),
      )
      .expect(202);
    await mailer.waitFor(email, VERIFY_LINK);
    const [message] = sentTo(email);
    expect(message.text).toContain('Hola:');
    expect(message.text).not.toMatch(/banco/);
    expect(message.html).not.toMatch(/banco/);
  });

  it('un nombre o un nombre de clínica de más de 120 caracteres: 400 en español', async () => {
    const res = await http()
      .post('/api/v1/auth/register')
      .set('X-Tenant-Host', 'localhost')
      .send(
        registerBody(REGIONAL_BOGOTA_FIXTURE, {
          clinicName: 'C'.repeat(121),
          subdomain: `${SUB_PREFIX}-largo`,
          email: `largo-${RUN}${DOMAIN}`,
          password: 'Clave-Larga-Dx144!',
          fullName: 'N'.repeat(121),
        }),
      )
      .expect(400);
    expect(JSON.stringify(res.body)).toContain(
      'El nombre de la clínica admite como mucho 120 caracteres',
    );
    expect(JSON.stringify(res.body)).toContain(
      'Tu nombre admite como mucho 120 caracteres',
    );
  });
});
