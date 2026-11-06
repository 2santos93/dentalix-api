import { HttpException, HttpStatus } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaEmailOutboxRepository } from '../src/modules/notifications/email/infrastructure/repositories/prisma-email-outbox.repository';
import { EmailPayloadCipher } from '../src/modules/notifications/email/infrastructure/email-payload-cipher';
import type { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { EmailOutbox } from '../src/modules/notifications/email/application/email-outbox.service';
import type { MailConfig } from '../src/modules/notifications/email/infrastructure/mail-config';
import { EmailQuotaExceededError } from '../src/modules/notifications/email/domain/email-quota-exceeded.error';
import { PrismaInvitationRepository } from '../src/modules/invitations/infrastructure/repositories/prisma-invitation.repository';
import { EmailInvitationNotifier } from '../src/modules/invitations/infrastructure/email-invitation-notifier';
import { ResendInvitationUseCase } from '../src/modules/invitations/application/use-cases/resend-invitation.use-case';
import { CreateInvitationUseCase } from '../src/modules/invitations/application/use-cases/create-invitation.use-case';
import {
  generateInvitationToken,
  hashInvitationToken,
} from '../src/modules/invitations/application/invitation-token';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import {
  type Outcome,
  pauseAfterSql,
  settle,
  sqlStop,
  waitForLockWaiters,
} from './support/postgres-concurrency';
import { purgeTenants } from './support/tenant-purge';

/**
 * DX-149-bis: los topes del email de una clínica (por destinatario y por
 * clínica, DX-088) se cuentan e insertan en UNA transacción `runWithTenant`
 * bajo `pg_advisory_xact_lock` de la clínica del contexto y el hash del
 * destinatario. Sin eso, N peticiones a la vez contaban todas lo mismo y se
 * saltaban el tope. Paralelo real: la primera se para con su fila insertada
 * (sin confirmar) y el resto TIENE que estar esperando a su candado
 * (pg_locks), nunca una pausa con reloj.
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const N = 10;
// Pool explícito de PRUEBA (como payment-receipt-balance): con el de Prisma
// por defecto (núcleos × 2 + 1) un runner de CI pequeño no abre las N
// transacciones a la vez y las que esperan conexión no llegan al candado.
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
process.env.DATABASE_URL = withConnectionLimit(
  ORIGINAL_DATABASE_URL ?? '',
  N * 2,
);
// Prisma lee la variable al conectar, no al construir: se restaura en afterAll.
const prisma = new PrismaService(tenantContext);

function withConnectionLimit(url: string, limit: number): string {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', String(limit));
  return parsed.toString();
}
const repo = new PrismaEmailOutboxRepository(prisma);
const cipher = new EmailPayloadCipher(randomBytes(32));
const SUFFIX = `${process.pid}-${Date.now()}`;
const tenants: string[] = [];
const INSERT_OUTBOX = /INSERT INTO "email_outbox"/;

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
  return new EmailOutbox(repo, cipher, noKick, cfg);
}

async function newTenant(label: string): Promise<string> {
  const { id } = await raw.tenant.create({
    data: {
      name: `Clínica Dental Altamira ${label}`,
      subdomain: `dx149bis-mail-${label}-${SUFFIX}`,
    },
  });
  tenants.push(id);
  return id;
}

const recipient = (n: number | string) =>
  `paciente.${n}.${SUFFIX}@clinica-caracas.test`;

const invitationEmail = (tenantId: string, to: string) => ({
  tenantId,
  to,
  template: 'invitation' as const,
  enforceQuota: true,
  vars: {
    inviteeName: 'María Rodríguez',
    roleLabel: 'Asistente',
    acceptUrl: `https://altamira.dentalix.app/invitacion/${generateInvitationToken()}`,
    expiresInDays: 7,
  },
});

const rowsTo = (tenantId: string, to: string) =>
  raw.emailOutbox.count({
    where: { tenantId, toHash: cipher.hashRecipient(to) },
  });

/**
 * Lanza `n` operaciones a la vez; la primera que inserte en email_outbox se
 * para (fila sin confirmar, candados tomados) hasta que las otras `n - 1`
 * esperen a sus candados. Devuelve todos los resultados.
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

const rejected = <T>(outcomes: Outcome<T>[]) =>
  outcomes
    .filter((o) => o.status === 'rejected')
    .map((o) => (o as { reason: unknown }).reason);

describe('DX-149-bis · topes de email sin carrera (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await purgeTenants(raw, tenants);
    await raw.$disconnect();
    await prisma.$disconnect();
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

  it(`${N} reenvíos a la vez de una invitación: un solo email (enfriamiento), los demás 429 y el enlace del email es el vigente`, async () => {
    const tenantId = await newTenant('reenvio');
    const outbox = outboxWith({
      tenantDaily: 50,
      recipientDaily: 5,
      recipientCooldownSeconds: 60,
    });
    const invitations = new PrismaInvitationRepository(prisma, tenantContext);
    const resend = new ResendInvitationUseCase(
      invitations,
      new EmailInvitationNotifier(outbox, tenantContext),
    );
    const to = recipient('invitada');
    const audit: AuditRequestContext = {
      tenantId,
      locationId: null,
      actor: { userId: randomUUID(), role: ClinicRole.ADMIN },
      requestId: null,
      ip: null,
      userAgent: null,
    };
    const invitation = await tenantContext.run(tenantId, () =>
      invitations.createReplacingPending(
        {
          id: randomUUID(),
          email: to,
          fullName: 'María Rodríguez',
          role: ClinicRole.ASSISTANT,
          tokenHash: hashInvitationToken(generateInvitationToken()),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        audit,
      ),
    );

    const outcomes = await raceBehindFirstInsert(N, () =>
      tenantContext.run(tenantId, () =>
        resend.execute(
          { id: invitation.id, linkBase: 'https://altamira.dentalix.app' },
          audit,
        ),
      ),
    );

    const won = outcomes.filter((o) => o.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const winner = (
      won[0] as { value: { token: string; emailDelivery: unknown } }
    ).value;
    expect(winner.emailDelivery).toBe('PENDING');
    const errors = rejected(outcomes);
    expect(errors).toHaveLength(N - 1);
    for (const error of errors) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    expect(await rowsTo(tenantId, to)).toBe(1);
    // El email que salió lleva el token que quedó guardado: los 429 no
    // regeneraron nada.
    const stored = await raw.clinicInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
      select: { tokenHash: true },
    });
    expect(stored.tokenHash).toBe(hashInvitationToken(winner.token));
  });

  it('dos altas a la vez de la misma invitación: queda UNA viva con su email encolado y el otro alta es un error de negocio', async () => {
    const tenantId = await newTenant('alta-doble');
    const outbox = outboxWith({
      tenantDaily: 50,
      recipientDaily: 5,
      recipientCooldownSeconds: 60,
    });
    const invitations = new PrismaInvitationRepository(prisma, tenantContext);
    const create = new CreateInvitationUseCase(
      invitations,
      new EmailInvitationNotifier(outbox, tenantContext),
      { tenantDaily: 30 },
    );
    const to = recipient('alta-doble');
    const audit: AuditRequestContext = {
      tenantId,
      locationId: null,
      actor: { userId: randomUUID(), role: ClinicRole.ADMIN },
      requestId: null,
      ip: null,
      userAgent: null,
    };

    const outcomes = await raceBehindFirstInsert(2, () =>
      tenantContext.run(tenantId, () =>
        create.execute(
          {
            fullName: 'María Rodríguez',
            email: to,
            role: ClinicRole.ASSISTANT,
            linkBase: 'https://altamira.dentalix.app',
          },
          audit,
        ),
      ),
    );

    const won = outcomes.filter((o) => o.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const winner = (
      won[0] as {
        value: { invitation: { id: string }; emailDelivery: unknown };
      }
    ).value;
    expect(winner.emailDelivery).toBe('PENDING');
    const [error] = rejected(outcomes);
    expect(error).toBeInstanceOf(HttpException);
    expect([HttpStatus.CONFLICT, HttpStatus.TOO_MANY_REQUESTS]).toContain(
      (error as HttpException).getStatus(),
    );
    const live = await raw.clinicInvitation.findMany({
      where: { tenantId, email: to, revokedAt: null, acceptedAt: null },
      select: { id: true },
    });
    expect(live).toEqual([{ id: winner.invitation.id }]);
    // Su email está encolado (no cancelado) y ningún otro email de esta
    // dirección sigue vivo con un enlace muerto.
    const mails = await raw.emailOutbox.findMany({
      where: { tenantId, toHash: cipher.hashRecipient(to) },
      select: { referenceId: true, status: true },
    });
    expect(mails).toEqual([
      { referenceId: winner.invitation.id, status: 'PENDING' },
    ]);
  });

  it(`${N} envíos a la vez al mismo destinatario no superan su tope diario`, async () => {
    const tenantId = await newTenant('diario');
    const outbox = outboxWith({
      tenantDaily: 50,
      recipientDaily: 3,
      recipientCooldownSeconds: 0,
    });
    const to = recipient('diario');

    const outcomes = await raceBehindFirstInsert(N, () =>
      outbox.enqueue(invitationEmail(tenantId, to)),
    );

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(3);
    const errors = rejected(outcomes);
    expect(errors).toHaveLength(N - 3);
    for (const error of errors) {
      expect(error).toBeInstanceOf(EmailQuotaExceededError);
    }
    expect(await rowsTo(tenantId, to)).toBe(3);
  });

  it(`el tope diario de la clínica tampoco se salta con ${N} destinatarios distintos a la vez`, async () => {
    const tenantId = await newTenant('clinica');
    const outbox = outboxWith({
      tenantDaily: 4,
      recipientDaily: 100,
      recipientCooldownSeconds: 0,
    });
    let next = 0;

    const outcomes = await raceBehindFirstInsert(N, () =>
      outbox.enqueue(invitationEmail(tenantId, recipient(`c${next++}`))),
    );

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(4);
    for (const error of rejected(outcomes)) {
      expect(error).toBeInstanceOf(EmailQuotaExceededError);
    }
    expect(await raw.emailOutbox.count({ where: { tenantId } })).toBe(4);
  });

  it('el candado es de la clínica del contexto: otra clínica con el mismo destinatario no espera', async () => {
    const tenantA = await newTenant('ctx-a');
    const tenantB = await newTenant('ctx-b');
    const outbox = outboxWith({
      tenantDaily: 50,
      recipientDaily: 5,
      recipientCooldownSeconds: 60,
    });
    const to = recipient('compartido');
    const stop = sqlStop(INSERT_OUTBOX);
    const restore = pauseAfterSql(prisma, [stop]);
    try {
      const first = settle(outbox.enqueue(invitationEmail(tenantA, to)));
      await stop.reached.wait;
      // A sigue parada con su candado: B termina sin esperarla.
      await expect(
        outbox.enqueue(invitationEmail(tenantB, to)),
      ).resolves.toEqual({ id: expect.any(String) as string });
      stop.release.open();
      expect((await first).status).toBe('fulfilled');
    } finally {
      restore();
    }
    expect(await rowsTo(tenantA, to)).toBe(1);
    expect(await rowsTo(tenantB, to)).toBe(1);
  });

  it('con tope, fuera de READ COMMITTED no inserta: contaría con una foto vieja', async () => {
    const tenantId = await newTenant('aislamiento');
    const to = recipient('aislamiento');
    const guard = jest.fn();

    await expect(
      prisma.runWithTenant(
        tenantId,
        (tx) =>
          repo.insertInTx(
            tx,
            {
              tenantId,
              template: 'invitation',
              toHash: cipher.hashRecipient(to),
              toMasked: 'pa***@clinica-caracas.test',
              referenceId: null,
              payload: Buffer.from('x'),
            },
            guard,
          ),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ),
    ).rejects.toThrow(/READ COMMITTED/);
    expect(guard).not.toHaveBeenCalled();
    expect(await rowsTo(tenantId, to)).toBe(0);
  });

  it('sin enforceQuota (p. ej. recordatorios) el envío no se frena por el tope ni toma el candado', async () => {
    const tenantId = await newTenant('libre');
    const outbox = outboxWith({
      tenantDaily: 1,
      recipientDaily: 1,
      recipientCooldownSeconds: 60,
    });
    const to = recipient('libre');
    const { enforceQuota: _ignored, ...free } = invitationEmail(tenantId, to);

    await outbox.enqueue(free);
    await outbox.enqueue(free);

    expect(await rowsTo(tenantId, to)).toBe(2);
  });
});
