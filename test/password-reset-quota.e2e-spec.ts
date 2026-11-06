import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppLogger, LogSink } from '../src/shared/observability/app-logger';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import type { Mailer } from '../src/modules/notifications/email/domain/ports/mailer.port';
import type { OutgoingEmail } from '../src/modules/notifications/email/domain/email-message';
import {
  loadMailConfig,
  MAIL_CONFIG,
} from '../src/modules/notifications/email/infrastructure/mail-config';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { FORGOT_PASSWORD_MESSAGE } from '../src/modules/auth/presentation/password-reset.controller';
import { hashPasswordResetToken } from '../src/modules/auth/application/password-reset-token';
import { createE2eApp } from './support/create-e2e-app';
import { hostFor } from './support/tenant-host';
import { pollUntil, registerVerified } from './support/register-verified';
import {
  REGIONAL_CARACAS_FIXTURE,
  registerBody,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';

// DX-149-ter (e2e): con el tope del destinatario alcanzado, «¿Olvidaste tu
// contraseña?» responde EXACTAMENTE lo mismo (código, cuerpo, cabeceras) que
// sin tope y que para un email sin cuenta, sin esperar al trabajo; y por
// detrás no rota el token ni encola otro email: el enlace que ya salió sigue
// valiendo.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUB = 'dx149ter-reset-tope';
const HOST = hostFor(SUB);
const DOMAIN = '@dx149ter-reset.test';
const USER_EMAIL = `luisa${DOMAIN}`;
const PASSWORD = 'Clave-Caracas-2026!';

type LogLine = Record<string, unknown>;

class RecordingMailer implements Mailer {
  readonly sent: OutgoingEmail[] = [];

  send(message: OutgoingEmail): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

async function cleanup(): Promise<void> {
  await raw.clinicMembership.deleteMany({
    where: { user: { email: { endsWith: DOMAIN } } },
  });
  await purgeTenantsBySubdomain(raw, [SUB]);
  await raw.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
}

describe('Restablecer contraseña con el tope alcanzado (e2e, DX-149-ter)', () => {
  let app: INestApplication<App>;
  let dispatcher: EmailDispatcher;
  let userId: string;
  const mailer = new RecordingMailer();
  const lines: LogLine[] = [];

  const forgot = (email: string) =>
    request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .set('X-Tenant-Host', HOST)
      .send({ email });

  const RESET_LINK = /\/restablecer\/([A-Za-z0-9_-]{43})/;
  /** Los correos de restablecimiento (el alta también manda el suyo). */
  const resets = () => mailer.sent.filter((m) => RESET_LINK.test(m.text));

  const outcomes = () =>
    lines
      .filter((l) => l.event === 'password_reset.requested')
      .map((l) => l.outcome);

  beforeAll(async () => {
    await cleanup();
    const sink: LogSink = (_stream, line) => {
      lines.push(JSON.parse(line) as LogLine);
    };
    app = await createE2eApp({
      logger: new AppLogger({ level: 'debug', format: 'json' }, sink),
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(mailer);
        // Tope real por destinatario (setup-e2e.ts los apaga para el resto):
        // un correo cada hora a la misma persona de la clínica.
        builder.overrideProvider(MAIL_CONFIG).useValue({
          ...loadMailConfig((key) => process.env[key]),
          quotas: {
            tenantDaily: 1000,
            recipientDaily: 5,
            recipientCooldownSeconds: 3600,
          },
        });
      },
    });
    dispatcher = app.get(EmailDispatcher, { strict: false });
    const registered = await registerVerified(
      app,
      registerBody(REGIONAL_CARACAS_FIXTURE, {
        clinicName: 'Clínica Dental Los Palos Grandes',
        subdomain: SUB,
        email: USER_EMAIL,
        password: PASSWORD,
        fullName: 'Luisa Restablece',
      }),
    );
    userId = (registered.body as { userId: string }).userId;
  });

  afterAll(async () => {
    await dispatcher.whenIdle();
    await app.close();
    await cleanup();
    await raw.$disconnect();
  });

  it('la respuesta pública es idéntica con y sin tope (y para un email sin cuenta); con tope no cambia el token ni sale otro correo', async () => {
    const free = await forgot(USER_EMAIL);
    await pollUntil(() => Promise.resolve(outcomes().length >= 1));
    expect(outcomes()).toEqual(['SENT']);
    await pollUntil(() => Promise.resolve(resets().length >= 1));
    await dispatcher.whenIdle();
    const [first] = await raw.userToken.findMany({ where: { userId } });
    const match = RESET_LINK.exec(resets()[0].text);
    expect(first.tokenHash).toBe(hashPasswordResetToken(match![1]));

    const capped = await forgot(USER_EMAIL);
    const missing = await forgot(`nadie${DOMAIN}`);
    await pollUntil(() => Promise.resolve(outcomes().length >= 3));

    expect(outcomes()).toEqual(['SENT', 'THROTTLED', 'NO_MEMBER']);
    for (const res of [free, capped, missing]) {
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ message: FORGOT_PASSWORD_MESSAGE });
      expect(res.headers['content-type']).toBe(free.headers['content-type']);
      expect(res.headers['content-length']).toBe(
        free.headers['content-length'],
      );
      expect(res.headers['cache-control']).toBe(free.headers['cache-control']);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['retry-after']).toBeUndefined();
    }
    // Por detrás: el token vigente es el del primer correo y no salió otro.
    await dispatcher.whenIdle();
    expect(await raw.userToken.findMany({ where: { userId } })).toEqual([
      first,
    ]);
    expect(resets()).toHaveLength(1);
    expect(
      await raw.emailOutbox.count({
        where: { template: 'PASSWORD_RESET', referenceId: userId },
      }),
    ).toBe(1);
  });
});
