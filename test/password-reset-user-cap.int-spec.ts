import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaEmailOutboxRepository } from '../src/modules/notifications/email/infrastructure/repositories/prisma-email-outbox.repository';
import { EmailPayloadCipher } from '../src/modules/notifications/email/infrastructure/email-payload-cipher';
import type { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { EmailOutbox } from '../src/modules/notifications/email/application/email-outbox.service';
import { EmailQuotaExceededError } from '../src/modules/notifications/email/domain/email-quota-exceeded.error';
import type { MailConfig } from '../src/modules/notifications/email/infrastructure/mail-config';
import { PrismaPasswordResetRepository } from '../src/modules/auth/infrastructure/repositories/prisma-password-reset.repository';
import { EmailPasswordResetNotifier } from '../src/modules/auth/infrastructure/email-password-reset.notifier';
import { RequestPasswordResetUseCase } from '../src/modules/auth/application/use-cases/request-password-reset.use-case';
import {
  type Outcome,
  backendPid,
  pauseAfterSql,
  settle,
  sqlStop,
  waitForLockWaiters,
} from './support/postgres-concurrency';
import { purgeTenants } from './support/tenant-purge';

/**
 * DX-149-quater, sobre Postgres:
 * - L1: el tope de restablecimientos es POR USUARIO, sumando todas sus
 *   clínicas, contado en `user_tokens` bajo el bloqueo de su fila. Una
 *   persona en 3 clínicas no recibe 3 × el tope pidiéndolo desde cada host.
 * - L2: los restablecimientos (endpoint público) no gastan ni respetan el
 *   tope diario de correos de la clínica: 60 no bloquean los del personal, y
 *   la clínica sin cupo no deja a nadie sin poder restablecer.
 * - L3: como mucho `concurrency` restablecimientos con transacción abierta a
 *   la vez por proceso; el resto espera turno, sin error.
 * Paralelo real, sin reloj: se espera a que las transacciones estén paradas
 * en un candado (pg_locks).
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const N = 15;
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

/** El caso de uso real sobre Postgres, con su límite de concurrencia. */
function useCase(
  outbox: EmailOutbox,
  concurrency: number,
  repo = new PrismaPasswordResetRepository(prisma, 10_000),
) {
  return new RequestPasswordResetUseCase(
    repo,
    new EmailPasswordResetNotifier(outbox),
    concurrency,
  );
}

async function clinic(label: string): Promise<string> {
  const tenant = await raw.tenant.create({
    data: {
      name: `Clínica Dental Altamira ${label}`,
      subdomain: `dx149q-${label}-${SUFFIX}`.slice(0, 63),
    },
    select: { id: true },
  });
  tenants.push(tenant.id);
  return tenant.id;
}

/** Una persona del personal, miembro activo de `tenantIds`. */
async function staff(
  label: string,
  tenantIds: string[],
): Promise<{ userId: string; email: string }> {
  const email = `${label}.${SUFFIX}@clinica-caracas.test`;
  const user = await raw.user.create({
    data: { email, passwordHash: 'HASH0', fullName: 'Luisa Pérez' },
    select: { id: true },
  });
  users.push(user.id);
  for (const tenantId of tenantIds) {
    await raw.clinicMembership.create({
      data: { tenantId, userId: user.id, role: 'RECEPTION' },
    });
  }
  return { userId: user.id, email };
}

const tokensOf = (userId: string) =>
  raw.userToken.findMany({
    where: { userId, purpose: 'PASSWORD_RESET' },
    select: { tokenHash: true, invalidatedAt: true },
  });

const values = <T>(outcomes: Outcome<T>[]): T[] =>
  outcomes.map((o) => {
    if (o.status === 'rejected') throw o.reason;
    return o.value;
  });

/** Un correo que dispara el personal (indicaciones tras la visita). */
const staffMail = (outbox: EmailOutbox, tenantId: string, n: number) =>
  outbox.enqueue({
    tenantId,
    to: `paciente.${n}.${SUFFIX}@correo-caracas.test`,
    template: 'post-op-instructions',
    referenceId: randomUUID(),
    enforceQuota: true,
    vars: {
      patientFirstName: 'María',
      clinicName: 'Clínica Dental Altamira',
      locationPhone: '+58 212 555 0101',
      url: `${LINK_BASE}/indicaciones/abc`,
      responsibleName: null,
    },
  });

describe('DX-149-quater · restablecer contraseña: tope por usuario, fuera del tope de la clínica y concurrencia acotada (int)', () => {
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

  it(`L1: ${N} peticiones a la vez desde 3 clínicas para la misma persona no pasan del tope por usuario (5)`, async () => {
    const hosts = [
      await clinic('chacao'),
      await clinic('baruta'),
      await clinic('el-hatillo'),
    ];
    const member = await staff('luisa.tres-sedes', hosts);
    // Cada clínica, por sí sola, dejaría 5 (su tope por destinatario).
    const quotas = {
      tenantDaily: 1000,
      recipientDaily: 5,
      recipientCooldownSeconds: 0,
    };
    const reset = useCase(outboxWith(quotas), N);

    // La primera que inserte su correo se para (sin confirmar, con la fila
    // del usuario bloqueada) hasta que las otras N-1 esperen detrás.
    const stop = sqlStop(INSERT_OUTBOX);
    const restore = pauseAfterSql(prisma, [stop]);
    let outcomes: string[];
    try {
      const all = Array.from({ length: N }, (_, i) =>
        settle(
          reset.execute({
            tenantId: hosts[i % hosts.length],
            email: member.email,
            linkBase: LINK_BASE,
          }),
        ),
      );
      const holder = await stop.reached.wait;
      await waitForLockWaiters(raw, [holder], N - 1);
      stop.release.open();
      outcomes = values(await Promise.all(all));
    } finally {
      restore();
    }

    expect(outcomes.filter((o) => o === 'SENT')).toHaveLength(5);
    expect(outcomes.filter((o) => o === 'THROTTLED')).toHaveLength(N - 5);
    const tokens = await tokensOf(member.userId);
    expect(tokens).toHaveLength(5);
    expect(tokens.filter((t) => t.invalidatedAt === null)).toHaveLength(1);
    // Ni un correo más que tokens, sumando las tres clínicas.
    expect(
      await raw.emailOutbox.count({
        where: {
          tenantId: { in: hosts },
          toHash: cipher.hashRecipient(member.email),
        },
      }),
    ).toBe(5);
  });

  it('L1: con el tope por usuario alcanzado, una clínica nueva para esa persona tampoco emite (ni token ni correo)', async () => {
    const [first, second] = [await clinic('los-palos'), await clinic('chuao')];
    const member = await staff('carmen.dos-sedes', [first, second]);
    const quotas = {
      tenantDaily: 1000,
      recipientDaily: 2,
      recipientCooldownSeconds: 0,
    };
    const reset = useCase(outboxWith(quotas), 4);
    const from = (tenantId: string) =>
      reset.execute({ tenantId, email: member.email, linkBase: LINK_BASE });

    await expect(from(first)).resolves.toBe('SENT');
    await expect(from(first)).resolves.toBe('SENT');
    const before = await tokensOf(member.userId);

    // La segunda clínica no le ha mandado nada: su tope por destinatario lo
    // dejaría, el del usuario (2 en 24 h) no.
    await expect(from(second)).resolves.toBe('THROTTLED');

    expect(await tokensOf(member.userId)).toEqual(before);
    expect(
      await raw.emailOutbox.count({
        where: { tenantId: second, toHash: cipher.hashRecipient(member.email) },
      }),
    ).toBe(0);
  });

  it('L2: 60 restablecimientos contra el personal de una clínica no le bloquean los correos del personal (tope diario 50)', async () => {
    const tenantId = await clinic('sesenta');
    const members = await Promise.all(
      Array.from({ length: 12 }, (_, i) => staff(`personal-${i}`, [tenantId])),
    );
    const outbox = outboxWith({
      tenantDaily: 50,
      recipientDaily: 5,
      recipientCooldownSeconds: 0,
    });
    const reset = useCase(outbox, 4);

    const outcomes = await Promise.all(
      members.map(async (m) => {
        const mine: string[] = [];
        for (let i = 0; i < 5; i++) {
          mine.push(
            await reset.execute({
              tenantId,
              email: m.email,
              linkBase: LINK_BASE,
            }),
          );
        }
        return mine;
      }),
    );

    expect(outcomes.flat()).toEqual(Array.from({ length: 60 }, () => 'SENT'));
    expect(
      await raw.emailOutbox.count({
        where: { tenantId, template: 'PASSWORD_RESET' },
      }),
    ).toBe(60);
    // El personal sigue pudiendo escribir: ni el aviso temprano ni el tope
    // contado bajo candado al encolar ven esos 60.
    await expect(
      outbox.assertWithinQuota(
        tenantId,
        `paciente.0.${SUFFIX}@correo-caracas.test`,
        'post-op-instructions',
      ),
    ).resolves.toBeUndefined();
    await expect(staffMail(outbox, tenantId, 0)).resolves.toEqual({
      id: expect.any(String) as string,
    });
  });

  it('L2: con el tope diario de la clínica agotado por el personal, el restablecimiento sigue saliendo', async () => {
    const tenantId = await clinic('sin-cupo');
    const member = await staff('sin-cupo', [tenantId]);
    const outbox = outboxWith({
      tenantDaily: 3,
      recipientDaily: 5,
      recipientCooldownSeconds: 0,
    });
    for (let i = 1; i <= 3; i++) await staffMail(outbox, tenantId, i);
    // El tope de la clínica sigue valiendo para el personal…
    await expect(staffMail(outbox, tenantId, 4)).rejects.toBeInstanceOf(
      EmailQuotaExceededError,
    );

    // …pero no deja a nadie sin poder restablecer su contraseña.
    await expect(
      useCase(outbox, 4).execute({
        tenantId,
        email: member.email,
        linkBase: LINK_BASE,
      }),
    ).resolves.toBe('SENT');
    expect(await tokensOf(member.userId)).toHaveLength(1);
  });

  it('L3: con 10 restablecimientos a la vez y concurrencia 3, nunca hay más de 3 transacciones abiertas; el resto espera turno y sale', async () => {
    const tenantId = await clinic('concurrencia');
    const members = await Promise.all(
      Array.from({ length: 10 }, (_, i) => staff(`cola-${i}`, [tenantId])),
    );
    const outbox = outboxWith({
      tenantDaily: 1000,
      recipientDaily: 5,
      recipientCooldownSeconds: 0,
    });
    const repo = new PrismaPasswordResetRepository(prisma, 10_000);
    const lookups = jest.spyOn(repo, 'findActiveMember');
    const reset = useCase(outbox, 3, repo);

    let open = 0;
    let peak = 0;
    const original = prisma.$transaction.bind(prisma) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const spy = jest
      .spyOn(prisma, '$transaction')
      .mockImplementation(async (...args: unknown[]) => {
        open++;
        peak = Math.max(peak, open);
        try {
          return await original(...args);
        } finally {
          open--;
        }
      });

    // Otra transacción retiene las filas de las 10 personas: cada
    // restablecimiento con turno se queda parado en su `FOR UPDATE`.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding!: (pid: number) => void;
    const held = new Promise<number>((resolve) => (holding = resolve));
    const holder = raw.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "users"
          WHERE "id" = ANY (${members.map((m) => m.userId)}::uuid[])
          FOR UPDATE`;
        holding(await backendPid(tx));
        await released;
      },
      { timeout: 30_000 },
    );
    try {
      const holderPid = await held;
      const all = members.map((m) =>
        settle(
          reset.execute({ tenantId, email: m.email, linkBase: LINK_BASE }),
        ),
      );
      await waitForLockWaiters(raw, [holderPid], 3);

      // Tres con turno, paradas en su transacción; las otras siete ni han
      // empezado (ni una lectura): esperan en la cola, sin error.
      expect(open).toBe(3);
      expect(lookups).toHaveBeenCalledTimes(3);

      release();
      await holder;
      expect(values(await Promise.all(all))).toEqual(
        Array.from({ length: 10 }, () => 'SENT'),
      );
    } finally {
      release();
      await holder.catch(() => undefined);
      spy.mockRestore();
    }
    expect(peak).toBe(3);
    expect(lookups).toHaveBeenCalledTimes(10);
  });
});
