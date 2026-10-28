import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppLogger, LogSink } from '../src/shared/observability/app-logger';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import type { Mailer } from '../src/modules/notifications/email/domain/ports/mailer.port';
import type { OutgoingEmail } from '../src/modules/notifications/email/domain/email-message';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { FORGOT_PASSWORD_MESSAGE } from '../src/modules/auth/presentation/password-reset.controller';
import { createE2eApp } from './support/create-e2e-app';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import {
  REGIONAL_BOGOTA_FIXTURE,
  registerBody,
} from './support/location-fixtures';

// DX-010 (e2e): «¿Olvidaste tu contraseña?» responde SIEMPRE 202 con el mismo
// cuerpo y sin esperar a nada; el email lleva la marca y el host de la
// clínica; el enlace es de un solo uso, caduca, se invalida al pedir otro y
// solo vale en una clínica del usuario; restablecer cierra todas las sesiones
// y deja un evento de auditoría; ni el log ni la BD llevan el token ni el
// email en claro.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUB_A = 'reset-e2e-a';
const SUB_B = 'reset-e2e-b';
const HOST_A = hostFor(SUB_A);
const HOST_B = hostFor(SUB_B);
const DOMAIN = '@reset-e2e.test';
const USER_EMAIL = `ana${DOMAIN}`;
const OTHER_EMAIL = `otra${DOMAIN}`;
const RETIRED_EMAIL = `baja${DOMAIN}`;
const PASSWORD = 'Clave-Vieja-2026!';
const NEW_PASSWORD = 'Clave-Nueva-2026!';

type LogLine = Record<string, unknown>;

class RecordingMailer implements Mailer {
  readonly sent: OutgoingEmail[] = [];
  delayMs = 0;

  async send(message: OutgoingEmail): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    this.sent.push(message);
  }
}

async function cleanup(): Promise<void> {
  await raw.clinicMembership.deleteMany({
    where: { user: { email: { endsWith: DOMAIN } } },
  });
  await raw.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await raw.tenant.deleteMany({ where: { subdomain: { in: [SUB_A, SUB_B] } } });
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline)
      throw new Error('timeout esperando la condición');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('Recuperar la contraseña (e2e, DX-010)', () => {
  let app: INestApplication<App>;
  let dispatcher: EmailDispatcher;
  let tenantA: string;
  let userId: string;
  const mailer = new RecordingMailer();
  const lines: LogLine[] = [];

  const post = (host: string, path: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/v1/auth/${path}`)
      .set('X-Tenant-Host', host)
      .send(body);

  const login = (host: string, email: string, password: string) =>
    post(host, 'login', { email, password });

  /** Pide el enlace y espera a que el email salga; devuelve el token. */
  async function requestLink(email = USER_EMAIL, host = HOST_A) {
    const before = mailer.sent.length;
    await post(host, 'forgot-password', { email }).expect(202);
    await waitUntil(() => mailer.sent.length > before);
    await dispatcher.whenIdle();
    const message = mailer.sent[mailer.sent.length - 1];
    const match = /\/restablecer\/([A-Za-z0-9_-]{43})/.exec(message.text);
    if (!match) throw new Error('el email no trae el enlace');
    return { token: match[1], message };
  }

  beforeAll(async () => {
    await cleanup();
    const sink: LogSink = (_stream, line) => {
      lines.push(JSON.parse(line) as LogLine);
    };
    app = await createE2eApp({
      logger: new AppLogger({ level: 'debug', format: 'json' }, sink),
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(mailer);
      },
    });
    dispatcher = app.get(EmailDispatcher);
    const register = (sub: string, email: string, clinicName: string) =>
      registerVerified(
        app,
        registerBody(REGIONAL_BOGOTA_FIXTURE, {
          clinicName,
          subdomain: sub,
          email,
          password: PASSWORD,
          fullName: 'Ana Restablece',
        }),
      );
    const a = await register(SUB_A, USER_EMAIL, 'Clínica Sonrisa Norte');
    tenantA = (a.body as { tenantId: string }).tenantId;
    userId = (a.body as { userId: string }).userId;
    await register(SUB_B, OTHER_EMAIL, 'Clínica Otra');
    // Una persona retirada de la clínica A (membresía con deletedAt).
    const retired = await raw.user.create({
      data: { email: RETIRED_EMAIL, passwordHash: 'x', fullName: 'Baja' },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: tenantA,
        userId: retired.id,
        role: 'RECEPTION',
        deletedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await dispatcher.whenIdle();
    await app.close();
    await cleanup();
    await raw.$disconnect();
  });

  beforeEach(async () => {
    await dispatcher.whenIdle();
    await raw.userToken.deleteMany({ where: { userId } });
    mailer.sent.length = 0;
    mailer.delayMs = 0;
    lines.length = 0;
  });

  it('202 idéntico exista o no el email, esté activo o sea de otra clínica, y nada cambia en la cuenta', async () => {
    const before = await raw.user.findUniqueOrThrow({ where: { id: userId } });
    const emails = [
      USER_EMAIL,
      `nadie${DOMAIN}`,
      RETIRED_EMAIL,
      OTHER_EMAIL,
      USER_EMAIL.toUpperCase(),
    ];
    const responses = [];
    for (const email of emails) {
      responses.push(await post(HOST_A, 'forgot-password', { email }));
    }
    for (const res of responses) {
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ message: FORGOT_PASSWORD_MESSAGE });
      expect(res.headers['content-length']).toBe(
        responses[0].headers['content-length'],
      );
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    // En un host sin clínica (o desconocido) también: 202 y el mismo cuerpo.
    const unknown = await post(hostFor('no-existe-e2e'), 'forgot-password', {
      email: USER_EMAIL,
    });
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual({ message: FORGOT_PASSWORD_MESSAGE });

    await waitUntil(() => mailer.sent.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await dispatcher.whenIdle();
    // Solo la miembro activa recibe el correo (dos veces, la segunda en
    // mayúsculas: el email se normaliza) y solo vale el último enlace.
    expect(mailer.sent.map((m) => m.to)).toEqual([USER_EMAIL, USER_EMAIL]);
    const tokens = await raw.userToken.findMany({ where: { userId } });
    expect(tokens).toHaveLength(2);
    expect(tokens.filter((t) => t.invalidatedAt === null)).toHaveLength(1);
    const after = await raw.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.tokenVersion).toBe(before.tokenVersion);
    // La contraseña de siempre sigue sirviendo (ni cambia ni se bloquea).
    await login(HOST_A, USER_EMAIL, PASSWORD).expect(201);
  });

  it('sin diferencia de tiempo apreciable: la respuesta no espera a la BD ni al proveedor', async () => {
    mailer.delayMs = 2_000;
    const time = async (email: string): Promise<number> => {
      const started = process.hrtime.bigint();
      await post(HOST_A, 'forgot-password', { email }).expect(202);
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    const existing: number[] = [];
    const missing: number[] = [];
    for (let i = 0; i < 5; i++) {
      existing.push(await time(USER_EMAIL));
      missing.push(await time(`fantasma${i}${DOMAIN}`));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[2];
    expect(median(existing)).toBeLessThan(150);
    expect(median(missing)).toBeLessThan(150);
    expect(Math.abs(median(existing) - median(missing))).toBeLessThan(50);
    await waitUntil(() => mailer.sent.length >= 1, 15_000);
  });

  it('flujo completo: email con la marca y el host de la clínica, restablecer, sesiones cerradas, un solo uso y auditoría', async () => {
    const startedAt = new Date();
    const session = await login(HOST_A, USER_EMAIL, PASSWORD).expect(201);
    const { refreshToken } = session.body as { refreshToken: string };

    const { token, message } = await requestLink();
    expect(message.subject).toBe('Restablece tu contraseña');
    expect(message.text).toContain(`http://${HOST_A}/restablecer/${token}`);
    expect(message.html).toContain(
      `href="http://${HOST_A}/restablecer/${token}"`,
    );
    expect(message.html).toContain('Clínica Sonrisa Norte');
    expect(message.text).toContain('30 minutos');

    const outbox = await raw.emailOutbox.findMany({
      where: {
        tenantId: tenantA,
        template: 'PASSWORD_RESET',
        createdAt: { gte: startedAt },
      },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: 'SENT', payload: null });

    await post(HOST_A, 'reset-password/check', { token })
      .expect(200)
      .expect({ status: 'VALID' });

    // La política de siempre (mínimo 8), en español, sin gastar el token.
    const short = await post(HOST_A, 'reset-password', {
      token,
      password: 'corta',
    }).expect(400);
    expect(JSON.stringify(short.body)).toContain('al menos 8 caracteres');

    await post(HOST_A, 'reset-password', {
      token,
      password: NEW_PASSWORD,
    }).expect(204);

    // Todas las sesiones previas quedan cerradas (tokenVersion).
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('X-Tenant-Host', HOST_A)
      .send({ refreshToken })
      .expect(401);
    await login(HOST_A, USER_EMAIL, PASSWORD).expect(401);
    await login(HOST_A, USER_EMAIL, NEW_PASSWORD).expect(201);

    // Un solo uso.
    await post(HOST_A, 'reset-password/check', { token })
      .expect(200)
      .expect({ status: 'USED' });
    const again = await post(HOST_A, 'reset-password', {
      token,
      password: 'Otra-Clave-2026!',
    }).expect(410);
    expect((again.body as { message: string }).message).toMatch(
      /ya se usó.*pide un enlace nuevo/i,
    );

    // Auditoría (DX-009): quién y cuándo, sin datos sensibles.
    const events = await raw.auditEvent.findMany({
      where: { tenantId: tenantA, action: 'PASSWORD_RESET' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: userId,
      actorRole: 'ADMIN',
      resourceType: 'SESSION',
      resourceId: null,
      patientId: null,
      metadata: {},
    });
    expect(JSON.stringify(events[0])).not.toContain(token);

    // Ni el log ni la BD llevan el token ni el email en claro.
    const logged = JSON.stringify(lines);
    expect(logged).toContain('password_reset.completed');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(USER_EMAIL);
    const rows = await raw.$queryRaw<{ row: string }[]>`
      SELECT to_jsonb(t)::text AS row FROM user_tokens t WHERE "userId" = ${userId}::uuid
      UNION ALL
      SELECT to_jsonb(o)::text FROM email_outbox o WHERE "tenantId" = ${tenantA}::uuid`;
    expect(rows.length).toBeGreaterThan(0);
    for (const { row } of rows) {
      expect(row).not.toContain(token);
      expect(row).not.toContain(USER_EMAIL);
    }

    // Deja la contraseña como estaba para los demás casos.
    const restore = await requestLink();
    await post(HOST_A, 'reset-password', {
      token: restore.token,
      password: PASSWORD,
    }).expect(204);
  });

  it('pedir otro enlace invalida el anterior (404 en español)', async () => {
    const first = await requestLink();
    const second = await requestLink();
    await post(HOST_A, 'reset-password/check', { token: first.token })
      .expect(200)
      .expect({ status: 'INVALID' });
    const res = await post(HOST_A, 'reset-password', {
      token: first.token,
      password: NEW_PASSWORD,
    }).expect(404);
    expect((res.body as { message: string }).message).toMatch(
      /no es válido.*Pide un enlace nuevo/,
    );
    await post(HOST_A, 'reset-password/check', { token: second.token })
      .expect(200)
      .expect({ status: 'VALID' });
  });

  it('caducado: 410 en español y la cuenta no cambia', async () => {
    const { token } = await requestLink();
    await raw.userToken.updateMany({
      where: { userId },
      data: {
        createdAt: new Date(Date.now() - 31 * 60_000),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    await post(HOST_A, 'reset-password/check', { token })
      .expect(200)
      .expect({ status: 'EXPIRED' });
    const res = await post(HOST_A, 'reset-password', {
      token,
      password: NEW_PASSWORD,
    }).expect(410);
    expect((res.body as { message: string }).message).toMatch(/caducó/);
    await login(HOST_A, USER_EMAIL, PASSWORD).expect(201);
  });

  it('inexistente: 404 en español', async () => {
    const res = await post(HOST_A, 'reset-password', {
      token: 'A'.repeat(43),
      password: NEW_PASSWORD,
    }).expect(404);
    expect((res.body as { message: string }).message).toMatch(/no es válido/);
  });

  it('aislamiento: el enlace no vale en el host de una clínica donde el usuario no es miembro activo', async () => {
    const { token } = await requestLink();
    await post(HOST_B, 'reset-password/check', { token })
      .expect(200)
      .expect({ status: 'INVALID' });
    await post(HOST_B, 'reset-password', {
      token,
      password: NEW_PASSWORD,
    }).expect(404);
    // Sigue vivo para su clínica.
    await post(HOST_A, 'reset-password/check', { token })
      .expect(200)
      .expect({ status: 'VALID' });
    // Y pedirlo desde la clínica B para un usuario de A no envía nada.
    const before = mailer.sent.length;
    await post(HOST_B, 'forgot-password', { email: USER_EMAIL }).expect(202);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await dispatcher.whenIdle();
    expect(mailer.sent.length).toBe(before);
  });
});
