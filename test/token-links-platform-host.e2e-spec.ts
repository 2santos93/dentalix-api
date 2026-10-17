import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import type { Mailer } from '../src/modules/notifications/email/domain/ports/mailer.port';
import type { OutgoingEmail } from '../src/modules/notifications/email/domain/email-message';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { FORGOT_PASSWORD_MESSAGE } from '../src/modules/auth/presentation/password-reset.controller';
import { createE2eApp } from './support/create-e2e-app';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';

// SEC-033 / DX-143 (e2e): los enlaces con un token que da control de la
// cuenta GLOBAL (restablecer la contraseña, invitación que puede reclamar una
// cuenta) NUNCA salen hacia el dominio personalizado de la clínica —cuyo DNS
// controla la clínica, no Dentalix— aunque la petición llegue por él: el email
// apunta al subdominio de plataforma `<subdominio>.<TENANT_BASE_DOMAINS[0]>`
// (`.env.test`: dentalix.app). Por un host de plataforma se mantiene ese host.

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUB = 'sec033-e2e';
const PLATFORM_HOST = hostFor(SUB); // sec033-e2e.localhost
const CANONICAL_HOST = `${SUB}.dentalix.app`; // primer dominio base
const CUSTOM_HOST = 'odonto-sec033.test';
const DOMAIN = '@sec033-e2e.test';
const ADMIN_EMAIL = `admin${DOMAIN}`;
const PASSWORD = 'Clave-Sec033-2026!';

class RecordingMailer implements Mailer {
  readonly sent: OutgoingEmail[] = [];
  send(message: OutgoingEmail): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

async function cleanup(): Promise<void> {
  await raw.clinicInvitation.deleteMany({
    where: { tenant: { subdomain: SUB } },
  });
  await raw.clinicMembership.deleteMany({
    where: { tenant: { subdomain: SUB } },
  });
  await raw.tenantDomain.deleteMany({ where: { host: CUSTOM_HOST } });
  await raw.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await raw.tenant.deleteMany({ where: { subdomain: SUB } });
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error('timeout esperando la condición');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Todas las URL http(s) del texto y del HTML del email. */
function urlsOf(email: OutgoingEmail): string[] {
  const found = `${email.text}\n${email.html}`.match(/https?:\/\/[^\s"<>]+/g);
  return found ?? [];
}

describe('Enlaces con token hacia el host de plataforma (e2e, SEC-033)', () => {
  let app: INestApplication<App>;
  let dispatcher: EmailDispatcher;
  let adminToken: string;
  let seq = 0;
  const mailer = new RecordingMailer();

  beforeAll(async () => {
    await cleanup();
    app = await createE2eApp({
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(mailer);
      },
    });
    dispatcher = app.get(EmailDispatcher);
    const register = await registerVerified(app, {
      clinicName: 'Clínica Dominio Propio',
      subdomain: SUB,
      email: ADMIN_EMAIL,
      password: PASSWORD,
      fullName: 'Dra. Propia',
    });
    const tenantId = (register.body as { tenantId: string }).tenantId;
    // Dominio personalizado VERIFIED (solo TXT: su A/CNAME lo controla la
    // clínica, SEC-009).
    await raw.tenantDomain.create({
      data: {
        tenantId,
        host: CUSTOM_HOST,
        status: 'VERIFIED',
        verifyToken: 'sec033-e2e',
        verifiedAt: new Date(),
      },
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', PLATFORM_HOST)
      .send({ email: ADMIN_EMAIL, password: PASSWORD })
      .expect(201);
    adminToken = (login.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await dispatcher.whenIdle();
    await app.close();
    await cleanup();
    await raw.$disconnect();
  });

  beforeEach(async () => {
    await dispatcher.whenIdle();
    mailer.sent.length = 0;
  });

  async function forgotPassword(host: string): Promise<OutgoingEmail> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .set('X-Tenant-Host', host)
      .send({ email: ADMIN_EMAIL })
      .expect(202);
    // El mismo 202 de siempre, venga por el host que venga.
    expect(res.body).toEqual({ message: FORGOT_PASSWORD_MESSAGE });
    await waitUntil(() => mailer.sent.length > 0);
    await dispatcher.whenIdle();
    expect(mailer.sent).toHaveLength(1);
    return mailer.sent[0];
  }

  const staff = (verb: 'post', path: string, host: string) =>
    request(app.getHttpServer())
      [verb](`/api/v1/staff/invitations${path}`)
      .set('X-Tenant-Host', host)
      .set('Authorization', `Bearer ${adminToken}`);

  async function invite(host: string): Promise<{ id: string; to: string }> {
    seq += 1;
    const to = `persona${seq}${DOMAIN}`;
    const res = await staff('post', '', host)
      .send({ fullName: `Persona ${seq}`, email: to, role: 'DENTIST' })
      .expect(201);
    return { id: (res.body as { id: string }).id, to };
  }

  function lastEmailTo(to: string): OutgoingEmail {
    const email = [...mailer.sent].reverse().find((m) => m.to === to);
    if (!email) throw new Error(`sin email para ${to}`);
    return email;
  }

  it('restablecer pedido por el dominio personalizado: el enlace va al subdominio de plataforma, nunca al dominio propio', async () => {
    const email = await forgotPassword(CUSTOM_HOST);
    expect(email.text).toMatch(
      new RegExp(`http://${CANONICAL_HOST}/restablecer/[A-Za-z0-9_-]{43}`),
    );
    expect(email.html).toMatch(
      new RegExp(
        `href="http://${CANONICAL_HOST}/restablecer/[A-Za-z0-9_-]{43}"`,
      ),
    );
    for (const url of urlsOf(email)) {
      expect(new URL(url).hostname).not.toBe(CUSTOM_HOST);
    }
    expect(`${email.text}${email.html}`).not.toContain(CUSTOM_HOST);
  });

  it('restablecer pedido por el host de plataforma: se mantiene ese host', async () => {
    const email = await forgotPassword(PLATFORM_HOST);
    expect(email.text).toMatch(
      new RegExp(`http://${PLATFORM_HOST}/restablecer/[A-Za-z0-9_-]{43}`),
    );
  });

  it('invitar desde el dominio personalizado: el enlace va al subdominio de plataforma', async () => {
    const { to } = await invite(CUSTOM_HOST);
    await dispatcher.whenIdle();
    const email = lastEmailTo(to);
    expect(email.text).toMatch(
      new RegExp(`http://${CANONICAL_HOST}/invitacion/[0-9a-f]{64}`),
    );
    expect(email.html).toMatch(
      new RegExp(`href="http://${CANONICAL_HOST}/invitacion/[0-9a-f]{64}"`),
    );
    for (const url of urlsOf(email)) {
      expect(new URL(url).hostname).not.toBe(CUSTOM_HOST);
    }
    expect(`${email.text}${email.html}`).not.toContain(CUSTOM_HOST);
  });

  it('reenviar desde el dominio personalizado: el enlace nuevo también va al subdominio de plataforma', async () => {
    const { id, to } = await invite(PLATFORM_HOST);
    await dispatcher.whenIdle();
    expect(lastEmailTo(to).text).toContain(
      `http://${PLATFORM_HOST}/invitacion/`,
    );
    mailer.sent.length = 0;

    await staff('post', `/${id}/resend`, CUSTOM_HOST).expect(200);
    await dispatcher.whenIdle();
    const email = lastEmailTo(to);
    expect(email.text).toMatch(
      new RegExp(`http://${CANONICAL_HOST}/invitacion/[0-9a-f]{64}`),
    );
    expect(`${email.text}${email.html}`).not.toContain(CUSTOM_HOST);
  });
});
