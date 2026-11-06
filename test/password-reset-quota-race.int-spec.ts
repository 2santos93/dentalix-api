import { randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaEmailOutboxRepository } from '../src/modules/notifications/email/infrastructure/repositories/prisma-email-outbox.repository';
import { EmailPayloadCipher } from '../src/modules/notifications/email/infrastructure/email-payload-cipher';
import type { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { EmailOutbox } from '../src/modules/notifications/email/application/email-outbox.service';
import type { MailConfig } from '../src/modules/notifications/email/infrastructure/mail-config';
import { PrismaPasswordResetRepository } from '../src/modules/auth/infrastructure/repositories/prisma-password-reset.repository';
import { EmailPasswordResetNotifier } from '../src/modules/auth/infrastructure/email-password-reset.notifier';
import { RequestPasswordResetUseCase } from '../src/modules/auth/application/use-cases/request-password-reset.use-case';
import { hashPasswordResetToken } from '../src/modules/auth/application/password-reset-token';
import {
  type Outcome,
  pauseAfterSql,
  settle,
  sqlStop,
  waitForLockWaiters,
} from './support/postgres-concurrency';
import { purgeTenants } from './support/tenant-purge';

/**
 * DX-149-ter: «¿Olvidaste tu contraseña?» es público. Emitir el token y
 * encolar su email van en UNA transacción, con el candado del destinatario
 * (solo ese: nunca el de la clínica) y un `lock_timeout` acotado. N peticiones
 * a la vez no pasan del tope de correos ni rotan más tokens que correos salen;
 * con el tope alcanzado (o el candado ocupado más allá del `lock_timeout`) el
 * token vigente sigue siendo el anterior. Paralelo real: la primera se para
 * con su email insertado (sin confirmar) y el resto TIENE que estar esperando
 * a un candado suyo (pg_locks), nunca una pausa con reloj.
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const N = 10;
// Pool explícito de PRUEBA (como email-recipient-quota-race): con el de
// Prisma por defecto un runner pequeño no abre las N transacciones a la vez.
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
process.env.DATABASE_URL = withConnectionLimit(
  ORIGINAL_DATABASE_URL ?? '',
  N * 2,
);
const prisma = new PrismaService(tenantContext);

function withConnectionLimit(url: string, limit: number): string {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', String(limit));
  return parsed.toString();
}

const cipher = new EmailPayloadCipher(randomBytes(32));
const outboxRepo = new PrismaEmailOutboxRepository(prisma);
const SUFFIX = `${process.pid}-${Date.now()}`;
const tenants: string[] = [];
const users: string[] = [];
const INSERT_OUTBOX = /INSERT INTO "email_outbox"/;
const LINK_BASE = 'https://altamira.dentalix.app';
const noKick = { kick: () => undefined } as unknown as EmailDispatcher;

function outboxWith(quotas: MailConfig['quotas']): EmailOutbox {
  const cfg = {
    transport: 'console',
    smtpUrl: null,
    fileDir: null,
    from: 'no-reply@dentalix.test',
    dispatchIntervalMs: 0,
    retryBaseMs: 60_000,
    leaseSeconds: 300,
    batchSize: 20,
    encryptionKey: randomBytes(32),
    ephemeralKey: false,
    production: false,
    quotas,
    platformQuotas: { recipientDaily: 1000, recipientCooldownSeconds: 0 },
  } satisfies MailConfig;
  return new EmailOutbox(outboxRepo, cipher, noKick, cfg);
}

/**
 * El caso de uso real sobre Postgres, con el `lock_timeout` del caso. Turnos
 * para las N a la vez (DX-149-quater): aquí se prueba la carrera, no la cola.
 */
function useCase(quotas: MailConfig['quotas'], lockTimeoutMs = 10_000) {
  return new RequestPasswordResetUseCase(
    new PrismaPasswordResetRepository(prisma, lockTimeoutMs),
    new EmailPasswordResetNotifier(outboxWith(quotas)),
    { concurrency: N },
  );
}

/** Una clínica de Caracas con una recepcionista activa. */
async function clinicWithMember(label: string) {
  const tenant = await raw.tenant.create({
    data: {
      name: `Clínica Dental Altamira ${label}`,
      subdomain: `dx149ter-reset-${label}-${SUFFIX}`,
    },
    select: { id: true },
  });
  tenants.push(tenant.id);
  const email = `recepcion.${label}.${SUFFIX}@clinica-caracas.test`;
  const user = await raw.user.create({
    data: { email, passwordHash: 'HASH0', fullName: 'Luisa Pérez' },
    select: { id: true },
  });
  users.push(user.id);
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'RECEPTION' },
  });
  return { tenantId: tenant.id, userId: user.id, email };
}

const tokensOf = (userId: string) =>
  raw.userToken.findMany({
    where: { userId, purpose: 'PASSWORD_RESET' },
    select: { tokenHash: true, invalidatedAt: true },
  });

const mailsTo = (tenantId: string, email: string) =>
  raw.emailOutbox.findMany({
    where: { tenantId, toHash: cipher.hashRecipient(email) },
    select: { id: true, payload: true, status: true },
    orderBy: { createdAt: 'asc' },
  });

/** El token del enlace que lleva un email del outbox. */
function tokenInMail(payload: Uint8Array | null): string {
  if (!payload) throw new Error('email sin payload');
  const { text } = cipher.decrypt(Buffer.from(payload));
  const match = /\/restablecer\/([A-Za-z0-9_-]{43})/.exec(text);
  if (!match) throw new Error('el email no trae el enlace');
  return match[1];
}

/**
 * Lanza `n` peticiones a la vez; la primera que inserte su email se para
 * (fila sin confirmar, candados tomados) hasta que las otras `n - 1` esperen
 * a un candado suyo. Devuelve todos los resultados.
 */
async function raceBehindFirstInsert<T>(
  n: number,
  run: () => Promise<T>,
): Promise<Outcome<T>[]> {
  const stop = sqlStop(INSERT_OUTBOX);
  const restore = pauseAfterSql(prisma, [stop]);
  try {
    const all = Array.from({ length: n }, () => settle(run()));
    const holder = await stop.reached.wait;
    await waitForLockWaiters(raw, [holder], n - 1);
    stop.release.open();
    return await Promise.all(all);
  } finally {
    restore();
  }
}

const values = <T>(outcomes: Outcome<T>[]): T[] =>
  outcomes.map((o) => {
    if (o.status === 'rejected') throw o.reason;
    return o.value;
  });

/** Una transacción del superusuario que retiene un candado hasta `release`. */
async function holdAdvisoryLock(
  key1: Prisma.Sql,
  key2: Prisma.Sql,
): Promise<{ release: () => Promise<void> }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let taken!: () => void;
  const isTaken = new Promise<void>((resolve) => (taken = resolve));
  const done = raw.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key1}, ${key2})`;
      taken();
      await released;
    },
    { timeout: 30_000 },
  );
  await isTaken;
  return {
    release: async () => {
      release();
      await done;
    },
  };
}

describe('DX-149-ter · restablecer contraseña: token y email en una transacción con candado (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await raw.userToken.deleteMany({ where: { userId: { in: users } } });
    await raw.clinicMembership.deleteMany({
      where: { userId: { in: users } },
    });
    await purgeTenants(raw, tenants);
    await raw.user.deleteMany({ where: { id: { in: users } } });
    await raw.$disconnect();
    await prisma.$disconnect();
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

  it(`${N} peticiones a la vez al mismo email: un correo (enfriamiento), un solo token rotado y el del correo es el vigente`, async () => {
    const member = await clinicWithMember('enfriamiento');
    const quotas = {
      tenantDaily: 50,
      recipientDaily: 5,
      recipientCooldownSeconds: 60,
    };
    const reset = useCase(quotas);

    const outcomes = values(
      await raceBehindFirstInsert(N, () =>
        reset.execute({
          tenantId: member.tenantId,
          email: member.email,
          linkBase: LINK_BASE,
        }),
      ),
    );

    expect(outcomes.filter((o) => o === 'SENT')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'THROTTLED')).toHaveLength(N - 1);
    const mails = await mailsTo(member.tenantId, member.email);
    expect(mails).toHaveLength(1);
    const tokens = await tokensOf(member.userId);
    // Ningún perdedor llegó a rotar el token: uno solo, vivo, el del correo.
    expect(tokens).toHaveLength(1);
    expect(tokens[0].invalidatedAt).toBeNull();
    expect(tokens[0].tokenHash).toBe(
      hashPasswordResetToken(tokenInMail(mails[0].payload)),
    );
  });

  it(`${N} peticiones a la vez con tope diario 3: como mucho 3 correos y 3 tokens, y el vigente es el del último correo`, async () => {
    const member = await clinicWithMember('diario');
    const quotas = {
      tenantDaily: 50,
      recipientDaily: 3,
      recipientCooldownSeconds: 0,
    };
    const reset = useCase(quotas);

    const outcomes = values(
      await raceBehindFirstInsert(N, () =>
        reset.execute({
          tenantId: member.tenantId,
          email: member.email,
          linkBase: LINK_BASE,
        }),
      ),
    );

    expect(outcomes.filter((o) => o === 'SENT')).toHaveLength(3);
    expect(outcomes.filter((o) => o === 'THROTTLED')).toHaveLength(N - 3);
    const mails = await mailsTo(member.tenantId, member.email);
    expect(mails).toHaveLength(3);
    const tokens = await tokensOf(member.userId);
    expect(tokens).toHaveLength(3);
    const live = tokens.filter((t) => t.invalidatedAt === null);
    expect(live).toHaveLength(1);
    // Solo el último correo sigue PENDING; los anteriores (enlace ya muerto)
    // quedaron cancelados en la misma transacción que rotó el token.
    const pending = mails.filter((m) => m.status === 'PENDING');
    expect(pending).toHaveLength(1);
    expect(live[0].tokenHash).toBe(
      hashPasswordResetToken(tokenInMail(pending[0].payload)),
    );
  });

  it('con el tope alcanzado el token vigente sigue siendo el anterior y no se encola nada', async () => {
    const member = await clinicWithMember('tope');
    const quotas = {
      tenantDaily: 50,
      recipientDaily: 5,
      recipientCooldownSeconds: 60,
    };
    const reset = useCase(quotas);
    const input = {
      tenantId: member.tenantId,
      email: member.email,
      linkBase: LINK_BASE,
    };
    await expect(reset.execute(input)).resolves.toBe('SENT');
    const [before] = await tokensOf(member.userId);

    await expect(reset.execute(input)).resolves.toBe('THROTTLED');

    expect(await tokensOf(member.userId)).toEqual([before]);
    expect(await mailsTo(member.tenantId, member.email)).toHaveLength(1);
  });

  it('si el candado del destinatario sigue ocupado tras el lock_timeout, cuenta como tope: ni token nuevo ni correo', async () => {
    const member = await clinicWithMember('lock-timeout');
    const quotas = {
      tenantDaily: 50,
      recipientDaily: 5,
      recipientCooldownSeconds: 0,
    };
    const input = {
      tenantId: member.tenantId,
      email: member.email,
      linkBase: LINK_BASE,
    };
    await expect(useCase(quotas).execute(input)).resolves.toBe('SENT');
    const [before] = await tokensOf(member.userId);
    // Otra transacción retiene el candado del destinatario de esta clínica.
    const held = await holdAdvisoryLock(
      Prisma.sql`hashtext(${`dx149_email_recipient:${member.tenantId}`})`,
      Prisma.sql`hashtext(${cipher.hashRecipient(member.email)})`,
    );
    try {
      await expect(useCase(quotas, 200).execute(input)).resolves.toBe(
        'THROTTLED',
      );
    } finally {
      await held.release();
    }

    expect(await tokensOf(member.userId)).toEqual([before]);
    expect(await mailsTo(member.tenantId, member.email)).toHaveLength(1);
  });

  it('no toma el candado de la clínica: con él ocupado, el restablecimiento sale igual', async () => {
    const member = await clinicWithMember('sin-candado-clinica');
    const quotas = {
      tenantDaily: 50,
      recipientDaily: 5,
      recipientCooldownSeconds: 60,
    };
    const held = await holdAdvisoryLock(
      Prisma.sql`hashtext(${`dx149_email_tenant:${member.tenantId}`})`,
      Prisma.sql`0`,
    );
    try {
      await expect(
        useCase(quotas, 200).execute({
          tenantId: member.tenantId,
          email: member.email,
          linkBase: LINK_BASE,
        }),
      ).resolves.toBe('SENT');
    } finally {
      await held.release();
    }
    expect(await tokensOf(member.userId)).toHaveLength(1);
    expect(await mailsTo(member.tenantId, member.email)).toHaveLength(1);
  });
});
