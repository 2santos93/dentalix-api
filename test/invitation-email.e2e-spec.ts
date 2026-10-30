import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppLogger, LogSink } from '../src/shared/observability/app-logger';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import type { Mailer } from '../src/modules/notifications/email/domain/ports/mailer.port';
import type { OutgoingEmail } from '../src/modules/notifications/email/domain/email-message';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { createE2eApp } from './support/create-e2e-app';
import {
  MAIL_CONFIG,
  loadMailConfig,
} from '../src/modules/notifications/email/infrastructure/mail-config';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import {
  REGIONAL_BOGOTA_FIXTURE,
  registerBody,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';

// DX-088 (e2e): invitar encola el email con el enlace del host de la clínica
// y responde sin esperar al proveedor; «Reenviar invitación» regenera el
// token (el anterior deja de servir, con mensaje en español) y reinicia los 7
// días; un proveedor caído nunca es un 500; y ni el log ni email_outbox llevan
// el email en claro ni el token.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUB = 'mail-e2e';
const HOST = hostFor(SUB);
const ADMIN_EMAIL = 'admin@mail-e2e.test';
const PASSWORD = 'Clave-Mail-2026!';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

type LogLine = Record<string, unknown>;

interface CreatedInvitation {
  id: string;
  email: string;
  expiresAt: string;
  emailDelivery: 'PENDING' | 'SENT' | 'FAILED' | null;
}

interface DirectoryEntry {
  kind: string;
  id: string;
  emailDelivery: 'PENDING' | 'SENT' | 'FAILED' | null;
}

/** Token del enlace del último email a `to` (DX-029: solo viaja por email). */
function tokenSentTo(sent: OutgoingEmail[], to: string): string {
  for (let i = sent.length - 1; i >= 0; i--) {
    const match = /\/invitacion\/([0-9a-f]{64})/.exec(sent[i].text);
    if (sent[i].to === to && match) return match[1];
  }
  throw new Error(`sin email de invitación para ${to}`);
}

/** Proveedor de pega: graba lo que recibe, puede tardar y puede fallar. */
class ScriptedMailer implements Mailer {
  readonly sent: OutgoingEmail[] = [];
  delayMs = 0;
  failWith: Error | null = null;

  async send(message: OutgoingEmail): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
  }
}

async function cleanup(): Promise<void> {
  await purgeTenantsBySubdomain(raw, [SUB]);
  await raw.user.deleteMany({
    where: { email: { endsWith: '@mail-e2e.test' } },
  });
}

describe('Email de invitación (e2e, DX-088)', () => {
  let app: INestApplication<App>;
  let dispatcher: EmailDispatcher;
  let adminToken: string;
  let tenantId: string;
  const mailer = new ScriptedMailer();
  const lines: LogLine[] = [];
  let seq = 0;

  const api = (verb: 'get' | 'post' | 'delete', path: string) =>
    request(app.getHttpServer())
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', HOST)
      .set('Authorization', `Bearer ${adminToken}`);

  const invite = async (
    overrides: Partial<{ email: string; fullName: string }> = {},
  ): Promise<CreatedInvitation> => {
    seq += 1;
    const res = await api('post', '/staff/invitations')
      .send({
        fullName: overrides.fullName ?? `Persona ${seq}`,
        email: overrides.email ?? `persona${seq}@mail-e2e.test`,
        role: 'ASSISTANT',
      })
      .expect(201);
    return res.body as CreatedInvitation;
  };

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

    const register = await registerVerified(
      app,
      registerBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: 'Clínica <b>Correo</b>',
        subdomain: SUB,
        email: ADMIN_EMAIL,
        password: PASSWORD,
        fullName: 'Dra. Correo',
      }),
    );
    tenantId = (register.body as { tenantId: string }).tenantId;
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', HOST)
      .send({ email: ADMIN_EMAIL, password: PASSWORD })
      .expect(201);
    adminToken = (login.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await raw.$disconnect();
  });

  beforeEach(async () => {
    await dispatcher.whenIdle();
    mailer.sent.length = 0;
    mailer.delayMs = 0;
    mailer.failWith = null;
    lines.length = 0;
  });

  it('invitar encola exactamente un email `invitation` con el enlace del host de la clínica y queda SENT', async () => {
    const created = await invite({
      email: 'ana.perez@mail-e2e.test',
      fullName: 'Ana <i>Pérez</i>',
    });
    expect(created.emailDelivery).toBe('PENDING');
    // DX-029: el ADMIN ya no recibe el token; solo viaja en el email.
    expect(created).not.toHaveProperty('token');

    await dispatcher.whenIdle();
    const token = tokenSentTo(mailer.sent, 'ana.perez@mail-e2e.test');
    const rows = await raw.emailOutbox.findMany({
      where: { referenceId: created.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId,
      template: 'INVITATION',
      status: 'SENT',
      attempts: 1,
      payload: null,
      toMasked: 'an***@mail-e2e.test',
    });

    expect(mailer.sent).toHaveLength(1);
    const email = mailer.sent[0];
    expect(email.to).toBe('ana.perez@mail-e2e.test');
    expect(email.subject).toBe('Te invitaron a unirte a Clínica <b>Correo</b>');
    expect(email.text).toContain(`http://${HOST}/invitacion/${token}`);
    expect(email.html).toContain(`href="http://${HOST}/invitacion/${token}"`);
    // Nombres escapados en el HTML (sin HTML injection).
    expect(email.html).toContain('Clínica &lt;b&gt;Correo&lt;/b&gt;');
    expect(email.html).toContain('Hola, Ana &lt;i&gt;Pérez&lt;/i&gt;');
    expect(email.html).not.toContain('<i>Pérez</i>');

    // El directorio de personal muestra el estado del envío.
    const directory = await api(
      'get',
      '/staff/directory?status=PENDING',
    ).expect(200);
    const entry = (directory.body as { items: DirectoryEntry[] }).items.find(
      (i) => i.id === created.id,
    );
    expect(entry).toMatchObject({ kind: 'INVITATION', emailDelivery: 'SENT' });
  });

  it('la respuesta no espera al proveedor: con un envío de 3 s responde en < 300 ms', async () => {
    mailer.delayMs = 3_000;
    const started = Date.now();
    const created = await invite();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(300);
    expect(created.emailDelivery).toBe('PENDING');

    const pending = await api('get', '/staff/directory?status=PENDING').expect(
      200,
    );
    expect(
      (pending.body as { items: DirectoryEntry[] }).items.find(
        (i) => i.id === created.id,
      )?.emailDelivery,
    ).toBe('PENDING');

    await dispatcher.whenIdle();
    expect(mailer.sent).toHaveLength(1);
  });

  it('proveedor caído: la invitación responde 201 (nunca 500), el envío suma el intento y queda programado', async () => {
    mailer.failWith = Object.assign(new Error('421 4.7.0 try again later'), {
      responseCode: 421,
    });
    const created = await invite();
    await dispatcher.whenIdle();

    const [row] = await raw.emailOutbox.findMany({
      where: { referenceId: created.id },
    });
    expect(row).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'Error 421',
    });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(mailer.sent).toHaveLength(0);
  });

  it('ni el log ni la fila llevan el email en claro ni el token', async () => {
    const email = 'secreta.persona@mail-e2e.test';
    const created = await invite({ email });
    await dispatcher.whenIdle();
    const token = tokenSentTo(mailer.sent, email);

    const log = JSON.stringify(lines);
    expect(lines.some((l) => l.event === 'email.enqueued')).toBe(true);
    expect(lines.some((l) => l.event === 'email.sent')).toBe(true);
    expect(log).not.toContain(email);
    expect(log).not.toContain(token);
    expect(log).toContain('se***@mail-e2e.test');

    const [{ text }] = await raw.$queryRaw<{ text: string }[]>`
      SELECT string_agg(to_jsonb(o)::text, ' ') AS text
        FROM email_outbox o WHERE o."referenceId" = ${created.id}::uuid`;
    expect(text).not.toContain(email);
    expect(text).not.toContain(token);
  });

  describe('POST /staff/invitations/:id/resend', () => {
    it('regenera el token: el anterior ya no sirve (mensaje en español) y el nuevo caduca a los 7 días', async () => {
      const created = await invite();
      await dispatcher.whenIdle();
      const oldToken = tokenSentTo(mailer.sent, created.email);
      mailer.sent.length = 0;

      const before = Date.now();
      const res = await api(
        'post',
        `/staff/invitations/${created.id}/resend`,
      ).expect(200);
      const resent = res.body as CreatedInvitation;
      expect(resent.id).toBe(created.id);
      expect(resent).not.toHaveProperty('token');
      expect(resent.emailDelivery).toBe('PENDING');
      const expiresAt = new Date(resent.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + SEVEN_DAYS_MS - 1_000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + SEVEN_DAYS_MS + 1_000);

      // El enlace viejo: la pantalla pública lo ve como inexistente…
      const oldLookup = await request(app.getHttpServer())
        .get(`/api/v1/public/invitations/${oldToken}`)
        .set('X-Tenant-Host', HOST)
        .expect(200);
      expect(oldLookup.body).toEqual({ status: 'NOT_FOUND' });
      // …y aceptarlo falla con un mensaje en español.
      const oldAccept = await request(app.getHttpServer())
        .post(`/api/v1/public/invitations/${oldToken}/accept`)
        .set('X-Tenant-Host', HOST)
        .send({ password: 'Clave-Nueva-2026!' })
        .expect(404);
      expect((oldAccept.body as { message: string }).message).toBe(
        'La invitación no existe o el enlace ya no es válido (puede que te hayan enviado uno más reciente).',
      );

      // Un email nuevo con el enlace nuevo; los dos envíos quedan registrados.
      await dispatcher.whenIdle();
      expect(mailer.sent).toHaveLength(1);
      const newToken = tokenSentTo(mailer.sent, created.email);
      expect(newToken).not.toBe(oldToken);
      expect(mailer.sent[0].text).not.toContain(oldToken);
      const rows = await raw.emailOutbox.findMany({
        where: { referenceId: created.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => r.status)).toEqual(['SENT', 'SENT']);

      // El nuevo sí sirve.
      await request(app.getHttpServer())
        .post(`/api/v1/public/invitations/${newToken}/accept`)
        .set('X-Tenant-Host', HOST)
        .send({ password: 'Clave-Nueva-2026!' })
        .expect(201);
    });

    it('cancela el email que seguía pendiente con el enlace anterior', async () => {
      mailer.failWith = new Error('down');
      const created = await invite();
      await dispatcher.whenIdle();
      mailer.failWith = null;

      await api('post', `/staff/invitations/${created.id}/resend`).expect(200);
      await dispatcher.whenIdle();
      const rows = await raw.emailOutbox.findMany({
        where: { referenceId: created.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => [r.status, r.lastError])).toEqual([
        ['FAILED', 'Superseded'],
        ['SENT', null],
      ]);
    });

    it('reinicia el plazo de una invitación caducada', async () => {
      const created = await invite();
      await raw.clinicInvitation.update({
        where: { id: created.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      const res = await api(
        'post',
        `/staff/invitations/${created.id}/resend`,
      ).expect(200);
      expect(
        new Date((res.body as CreatedInvitation).expiresAt).getTime(),
      ).toBeGreaterThan(Date.now() + SEVEN_DAYS_MS - 60_000);
    });

    it('404 en español si ya se aceptó o se revocó; 400 con un id que no es UUID', async () => {
      const revoked = await invite();
      await api('delete', `/staff/invitations/${revoked.id}`).expect(204);
      const res = await api(
        'post',
        `/staff/invitations/${revoked.id}/resend`,
      ).expect(404);
      expect((res.body as { message: string }).message).toBe(
        'No encontramos una invitación pendiente con ese id.',
      );
      await api('post', '/staff/invitations/no-es-uuid/resend').expect(400);
    });

    it('revocar cancela el email pendiente', async () => {
      mailer.failWith = new Error('down');
      const created = await invite();
      await dispatcher.whenIdle();
      await api('delete', `/staff/invitations/${created.id}`).expect(204);
      const [row] = await raw.emailOutbox.findMany({
        where: { referenceId: created.id },
      });
      expect(row).toMatchObject({
        status: 'FAILED',
        lastError: 'Superseded',
        payload: null,
      });
    });
  });

  it('fullName y email con longitud máxima (120 / 254): 400', async () => {
    await api('post', '/staff/invitations')
      .send({
        fullName: 'x'.repeat(121),
        email: 'largo@mail-e2e.test',
        role: 'ASSISTANT',
      })
      .expect(400);
    await api('post', '/staff/invitations')
      .send({
        fullName: 'Ana',
        email: `${'a'.repeat(250)}@mail-e2e.test`,
        role: 'ASSISTANT',
      })
      .expect(400);
  });

  describe('topes anti-abuso en BD (revisión B1)', () => {
    let limited: INestApplication<App>;

    beforeAll(async () => {
      limited = await createE2eApp({
        override: (builder) => {
          builder.overrideProvider(MAILER).useValue(mailer);
          builder.overrideProvider(MAIL_CONFIG).useValue({
            ...loadMailConfig((key) => process.env[key]),
            quotas: {
              tenantDaily: 50,
              recipientDaily: 5,
              recipientCooldownSeconds: 60,
            },
          });
        },
      });
    });

    afterAll(async () => {
      await limited.get(EmailDispatcher).whenIdle();
      await limited.close();
    });

    const call = (verb: 'post', path: string) =>
      request(limited.getHttpServer())
        [verb](`/api/v1${path}`)
        .set('X-Tenant-Host', HOST)
        .set('Authorization', `Bearer ${adminToken}`);

    it('reenviar al momento → 429 en español, y el enlace vigente sigue valiendo', async () => {
      const created = (
        await call('post', '/staff/invitations')
          .send({
            fullName: 'Tope',
            email: 'tope@mail-e2e.test',
            role: 'ASSISTANT',
          })
          .expect(201)
      ).body as CreatedInvitation;
      await limited.get(EmailDispatcher).whenIdle();
      const token = tokenSentTo(mailer.sent, 'tope@mail-e2e.test');

      const res = await call(
        'post',
        `/staff/invitations/${created.id}/resend`,
      ).expect(429);
      expect((res.body as { message: string }).message).toMatch(
        /^Ya enviamos un correo a esta persona hace un momento\. Espera \d+ segundos/,
      );
      // Invitar otra vez al mismo correo tampoco esquiva el tope.
      await call('post', '/staff/invitations')
        .send({
          fullName: 'Tope',
          email: 'tope@mail-e2e.test',
          role: 'ASSISTANT',
        })
        .expect(429);

      const lookup = await request(limited.getHttpServer())
        .get(`/api/v1/public/invitations/${token}`)
        .set('X-Tenant-Host', HOST)
        .expect(200);
      expect((lookup.body as { status: string }).status).toBe('VALID');
      expect(
        await raw.emailOutbox.count({ where: { referenceId: created.id } }),
      ).toBe(1);
    });
  });
});
