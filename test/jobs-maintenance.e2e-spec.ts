// PRIMERO: ConfigModule.forRoot lee el entorno al importar AppModule.
import { restoreExchangeAppId } from './support/with-exchange-app-id';
import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { Clinic, registerClinic, resetDatabase } from './support/e2e-fixtures';
import { JobRegistry } from '../src/modules/jobs/application/job-registry';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import { EXCHANGE_RATE_PROVIDER } from '../src/modules/exchange/domain/ports/exchange-rate-provider.port';
import type { ExchangeRateProvider } from '../src/modules/exchange/domain/ports/exchange-rate-provider.port';

// DX-085: las tareas iniciales corren PROGRAMADAS, con la app real
// (AppModule): purga de tokens vencidos (revoked_tokens, user_tokens,
// pending_registrations), purga de email_outbox terminado y precarga diaria
// de los tipos de cambio. El tick se provoca adelantando el `nextRunAt` de la
// tarea en job_schedules (no se espera al reloj) y lo ejecuta el worker.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const hex = () => randomBytes(32).toString('hex');

const fetchRates = jest.fn<
  ReturnType<ExchangeRateProvider['fetchRates']>,
  [string]
>(() => Promise.resolve({ base: 'USD', rates: { COP: 4100.5, EUR: 0.91 } }));

describe('Tareas programadas iniciales (e2e, DX-085)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;

  /** Hace que la tarea venza ya y deja que el worker la ejecute. */
  async function tick(schedule: string): Promise<void> {
    const worker = app.get(JobWorker);
    await worker.runOnce(); // crea las filas de job_schedules si faltan
    await raw.jobSchedule.update({
      where: { name: schedule },
      data: { nextRunAt: ago(60_000) },
    });
    await worker.drain();
  }

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder
          .overrideProvider(EXCHANGE_RATE_PROVIDER)
          .useValue({ fetchRates }),
    });
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'clinica-mantenimiento');
  });

  afterAll(async () => {
    restoreExchangeAppId();
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: new Date().toISOString().slice(0, 10) },
    });
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('registra las tareas programadas iniciales con su cron (UTC)', () => {
    const schedules = app
      .get(JobRegistry)
      .schedules()
      .map(({ name, cron, job }) => ({ name, cron, job }));
    expect(schedules).toEqual(
      expect.arrayContaining([
        {
          name: 'auth.purge-expired-tokens.hourly',
          cron: '17 * * * *',
          job: 'auth.purge-expired-tokens',
        },
        {
          name: 'email.purge-outbox.daily',
          cron: '23 4 * * *',
          job: 'email.purge-outbox',
        },
        {
          name: 'exchange.prefetch-rates.daily',
          cron: '5 0 * * *',
          job: 'exchange.prefetch-rates',
        },
        {
          name: 'jobs.purge-finished.daily',
          cron: '41 3 * * *',
          job: 'jobs.purge-finished',
        },
      ]),
    );
  });

  it('purga los tokens vencidos y conserva los vigentes', async () => {
    await raw.revokedToken.createMany({
      data: [
        { jti: 'dx085-vencido', expiresAt: ago(60_000) },
        { jti: 'dx085-vigente', expiresAt: new Date(Date.now() + DAY) },
      ],
    });
    const user = await raw.user.findFirstOrThrow({
      where: { id: clinic.adminUserId },
    });
    // createdAt explícito: el CHECK exige expiresAt > createdAt; los hashes
    // son hex (CHECK) y su primer carácter dice qué caso es.
    const token = (
      kind: string,
      createdAt: Date,
      expiresAt: Date,
      usedAt?: Date,
    ) => ({
      userId: user.id,
      purpose: 'PASSWORD_RESET' as const,
      tokenHash: kind.repeat(64),
      createdAt,
      expiresAt,
      ...(usedAt ? { usedAt, invalidatedAt: usedAt } : {}),
    });
    await raw.userToken.createMany({
      data: [
        // Caducado hace más del margen de 7 días: fuera.
        token('a', ago(9 * DAY), ago(8 * DAY)),
        // Usado hace más del margen: fuera.
        token('b', ago(9 * DAY), ago(8 * DAY - 60_000), ago(8 * DAY)),
        // Caducado ayer: aún dice EXPIRED a quien abra el enlace.
        token('c', ago(2 * DAY), ago(DAY)),
        // Vigente.
        token('d', ago(60_000), new Date(Date.now() + DAY)),
      ],
    });
    await raw.pendingRegistration.createMany({
      data: ['vencido', 'vigente'].map((kind) => ({
        email: `dx085-${kind}@example.com`,
        clinicName: 'Clínica',
        subdomain: `dx085-${kind}`,
        fullName: 'Ana',
        passwordHash: 'x',
        tokenHash: hex(),
        createdAt: ago(2 * DAY),
        expiresAt:
          kind === 'vencido' ? ago(60_000) : new Date(Date.now() + DAY),
      })),
    });

    await tick('auth.purge-expired-tokens.hourly');

    expect(
      (
        await raw.revokedToken.findMany({
          where: { jti: { startsWith: 'dx085-' } },
        })
      ).map((t) => t.jti),
    ).toEqual(['dx085-vigente']);
    expect(
      (await raw.userToken.findMany({ where: { userId: user.id } }))
        .map((t) => t.tokenHash[0])
        .sort(),
    ).toEqual(['c', 'd']);
    expect(
      (
        await raw.pendingRegistration.findMany({
          where: { email: { startsWith: 'dx085-' } },
        })
      ).map((p) => p.email),
    ).toEqual(['dx085-vigente@example.com']);
    const [job] = await raw.job.findMany({
      where: { name: 'auth.purge-expired-tokens' },
    });
    expect(job).toMatchObject({ state: 'COMPLETED', tenantId: null });
  });

  it('purga de email_outbox los envíos terminados antiguos de cada clínica, y nada pendiente', async () => {
    const base = {
      tenantId: clinic.tenantId,
      template: 'INVITATION' as const,
      toMasked: 'an***@example.com',
      updatedAt: new Date(),
    };
    await raw.emailOutbox.createMany({
      data: [
        {
          ...base,
          id: '00000000-0000-4000-8000-0000000000a1',
          toHash: hex(),
          status: 'SENT',
          createdAt: ago(100 * DAY),
        },
        {
          ...base,
          id: '00000000-0000-4000-8000-0000000000a2',
          toHash: hex(),
          status: 'FAILED',
          createdAt: ago(100 * DAY),
        },
        {
          ...base,
          id: '00000000-0000-4000-8000-0000000000a3',
          toHash: hex(),
          status: 'SENT',
          createdAt: ago(10 * DAY),
        },
        {
          ...base,
          id: '00000000-0000-4000-8000-0000000000a4',
          toHash: hex(),
          status: 'PENDING',
          payload: Buffer.from('x'),
          createdAt: ago(100 * DAY),
        },
      ],
    });

    await tick('email.purge-outbox.daily');

    const left = await raw.emailOutbox.findMany({
      where: { tenantId: clinic.tenantId },
      select: { id: true },
    });
    expect(left.map((r) => r.id.slice(-2)).sort()).toEqual(
      expect.arrayContaining(['a3', 'a4']),
    );
    expect(left.map((r) => r.id.slice(-2))).not.toEqual(
      expect.arrayContaining(['a1']),
    );
    expect(left.map((r) => r.id.slice(-2))).not.toEqual(
      expect.arrayContaining(['a2']),
    );
  });

  it('precarga los tipos de cambio de hoy (UTC) en exchange_rate_snapshots', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await raw.exchangeRateSnapshot.deleteMany({ where: { date: today } });

    await tick('exchange.prefetch-rates.daily');

    expect(fetchRates).toHaveBeenCalledWith(today);
    const rows = await raw.exchangeRateSnapshot.findMany({
      where: { date: today },
      orderBy: { currency: 'asc' },
    });
    expect(rows.map((r) => [r.currency, r.rate.toNumber()])).toEqual([
      ['COP', 4100.5],
      ['EUR', 0.91],
    ]);
  });
});
