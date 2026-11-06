import { NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaAuthRepository } from '../src/modules/auth/infrastructure/repositories/prisma-auth.repository';
import { PrismaRegistrationRepository } from '../src/modules/auth/infrastructure/repositories/prisma-registration.repository';
import {
  REGISTRATION_LINK_INVALID,
  RegisterClinicUseCase,
} from '../src/modules/auth/application/use-cases/register-clinic.use-case';
import {
  generateRegistrationToken,
  hashRegistrationToken,
  registrationExpiresAt,
} from '../src/modules/auth/application/registration-token';
import type { RegistrationNotifier } from '../src/modules/auth/domain/ports/registration-notifier.port';
import { TestPasswordHasher } from '../src/shared/testing/test-password-hasher';
import { REGIONAL_CARACAS_FIXTURE } from './support/location-fixtures';
import {
  backendPid,
  gate,
  settle,
  waitForLockWaiters,
} from './support/postgres-concurrency';
import { purgeTenantsBySubdomain } from './support/tenant-purge';

/**
 * DX-149-bis: abrir el enlace del registro consume el pendiente en la MISMA
 * transacción que crea la clínica, contra Postgres real con el rol de la app.
 * Si el alta falla a medias, el pendiente sigue y el mismo enlace vuelve a
 * servir; dos usos a la vez crean UNA clínica y el otro recibe el 404 de
 * enlace ya usado (nunca un 500 ni dos clínicas).
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const prisma = new PrismaService(new TenantContextService());
const SUFFIX = `${process.pid}-${Date.now()}`;
const PASSWORD = 'Caracas-2026!';
const REQ = { requestId: 'dx149bis', ip: '10.0.0.9', userAgent: 'jest' };
const subdomains: string[] = [];
const emails: string[] = [];

/** El paso privado del alta donde se inyecta el fallo (ya dentro de su tx). */
type MainLocationStep = {
  createMainLocation: (
    tx: Prisma.TransactionClient,
    ...rest: unknown[]
  ) => Promise<{ id: string; timeZone: string }>;
};

const NOTIFIER: RegistrationNotifier = {
  recipientCooldownSeconds: 0,
  withinRecipientQuota: () => Promise.resolve(true),
  sendVerification: () => Promise.resolve(true),
  sendExistingAccountNotice: () => Promise.resolve(true),
};
const ANY_CODE = { has: () => Promise.resolve(true) };

function wire() {
  const auth = new PrismaAuthRepository(
    prisma,
    { platformMinYears: 15 },
    false,
  );
  const pending = new PrismaRegistrationRepository(prisma);
  const password = new TestPasswordHasher();
  const uc = new RegisterClinicUseCase(
    auth,
    pending,
    NOTIFIER,
    password,
    ANY_CODE,
    ANY_CODE,
  );
  return { auth, pending, password, uc };
}

async function pendingLink(
  label: string,
  ctx: ReturnType<typeof wire>,
): Promise<{ token: string; subdomain: string; email: string }> {
  const subdomain = `dx149bis-${label}-${SUFFIX}`;
  const email = `dra.${label}.${SUFFIX}@clinica-caracas.test`;
  subdomains.push(subdomain);
  emails.push(email);
  const token = generateRegistrationToken();
  const saved = await ctx.pending.savePending({
    email,
    clinicName: 'Clínica Dental Altamira',
    subdomain,
    fullName: 'Dra. María Rodríguez',
    passwordHash: await ctx.password.hash(PASSWORD),
    tokenHash: hashRegistrationToken(token),
    expiresAt: registrationExpiresAt(new Date()),
    replaceCreatedBefore: new Date(),
    location: {
      country: REGIONAL_CARACAS_FIXTURE.country,
      currency: REGIONAL_CARACAS_FIXTURE.currency,
      timeZone: REGIONAL_CARACAS_FIXTURE.timeZone,
      locale: REGIONAL_CARACAS_FIXTURE.locale,
      hourCycle: REGIONAL_CARACAS_FIXTURE.hourCycle,
    },
  });
  expect(saved).toBe(true);
  return { token, subdomain, email };
}

const tenantsWith = (subdomain: string) =>
  raw.tenant.count({ where: { subdomain } });
const pendingWith = (token: string) =>
  raw.pendingRegistration.count({
    where: { tokenHash: hashRegistrationToken(token) },
  });

describe('DX-149-bis · verify del registro en una sola transacción (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, subdomains);
    await raw.user.deleteMany({ where: { email: { in: emails } } });
    await raw.pendingRegistration.deleteMany({
      where: { email: { in: emails } },
    });
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  it('si el alta falla dentro de su transacción, el pendiente sigue y el mismo enlace crea la clínica después', async () => {
    const ctx = wire();
    const link = await pendingLink('fallo', ctx);
    jest
      .spyOn(ctx.auth as unknown as MainLocationStep, 'createMainLocation')
      .mockRejectedValueOnce(new Error('fallo inyectado en el alta'));

    await expect(ctx.uc.verify(link.token, PASSWORD, REQ)).rejects.toThrow(
      'fallo inyectado en el alta',
    );
    expect(await pendingWith(link.token)).toBe(1);
    expect(await tenantsWith(link.subdomain)).toBe(0);
    expect(await raw.user.count({ where: { email: link.email } })).toBe(0);

    const created = await ctx.uc.verify(link.token, PASSWORD, REQ);
    expect(created.subdomain).toBe(link.subdomain);
    expect(await tenantsWith(link.subdomain)).toBe(1);
    expect(await pendingWith(link.token)).toBe(0);
  });

  it('dos usos a la vez del mismo enlace: el segundo espera al primero dentro de la transacción y recibe el 404 de enlace usado', async () => {
    const ctx = wire();
    const link = await pendingLink('doble', ctx);
    // El primer uso se para YA dentro de su transacción (pendiente borrado,
    // clínica sin confirmar); el segundo tiene que esperar a su candado de
    // fila, no leer un pendiente ya borrado fuera de ella.
    const held = gate<number>();
    const release = gate();
    const step = ctx.auth as unknown as MainLocationStep;
    const original = step.createMainLocation.bind(ctx.auth);
    jest
      .spyOn(step, 'createMainLocation')
      .mockImplementationOnce(async (tx, ...rest) => {
        held.open(await backendPid(tx));
        await release.wait;
        return original(tx, ...rest);
      });

    const first = settle(ctx.uc.verify(link.token, PASSWORD, REQ));
    const holder = await held.wait;
    const second = settle(ctx.uc.verify(link.token, PASSWORD, REQ));
    await waitForLockWaiters(raw, [holder], 1);
    release.open();

    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    const reason = (b as { reason: unknown }).reason;
    expect(reason).toBeInstanceOf(NotFoundException);
    expect((reason as NotFoundException).message).toBe(
      REGISTRATION_LINK_INVALID,
    );
    expect(await tenantsWith(link.subdomain)).toBe(1);
    expect(await raw.user.count({ where: { email: link.email } })).toBe(1);
    expect(await pendingWith(link.token)).toBe(0);
  });

  it('si el primer uso se deshace mientras el segundo espera, el segundo crea la clínica', async () => {
    const ctx = wire();
    const link = await pendingLink('rollback', ctx);
    const held = gate<number>();
    const release = gate();
    jest
      .spyOn(ctx.auth as unknown as MainLocationStep, 'createMainLocation')
      .mockImplementationOnce(async (tx) => {
        held.open(await backendPid(tx));
        await release.wait;
        throw new Error('fallo inyectado en el primer uso');
      });

    const first = settle(ctx.uc.verify(link.token, PASSWORD, REQ));
    const holder = await held.wait;
    const second = settle(ctx.uc.verify(link.token, PASSWORD, REQ));
    await waitForLockWaiters(raw, [holder], 1);
    release.open();

    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe('rejected');
    expect(String((a as { reason: unknown }).reason)).toContain(
      'fallo inyectado en el primer uso',
    );
    expect(b.status).toBe('fulfilled');
    expect(await tenantsWith(link.subdomain)).toBe(1);
    expect(await pendingWith(link.token)).toBe(0);
  });

  it('dos usos a la vez sin pausas: exactamente una clínica y el otro es un 404, nunca un 500', async () => {
    const ctx = wire();
    const link = await pendingLink('par', ctx);

    const outcomes = await Promise.all(
      [0, 1].map(() => settle(ctx.uc.verify(link.token, PASSWORD, REQ))),
    );

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const [rejected] = outcomes.filter((o) => o.status === 'rejected');
    expect((rejected as { reason: unknown }).reason).toBeInstanceOf(
      NotFoundException,
    );
    expect(await tenantsWith(link.subdomain)).toBe(1);
  });
});
