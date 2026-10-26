import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  arqueo,
  type ExpectedLine,
} from '../src/modules/cash-sessions/domain/arqueo';
import type { ClosingDraft } from '../src/modules/cash-sessions/domain/ports/cash-session-repository.port';
import { ExpenseCashSession } from '../src/modules/cash-sessions/infrastructure/expense-cash-session';
import { PrismaCashSessionRepository } from '../src/modules/cash-sessions/infrastructure/prisma-cash-session.repository';
import { OPEN_CASH_SESSION_REQUIRED_MESSAGE } from '../src/modules/expenses/domain/expense-rules';
import type {
  ExpenseCashContext,
  ExpenseCashLink,
} from '../src/modules/expenses/domain/ports/expense-cash-link.port';
import { PrismaExpenseRepository } from '../src/modules/expenses/infrastructure/repositories/prisma-expense.repository';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  gate,
  settle,
  transactionId,
  waitForTransactionWaiters,
} from './support/postgres-concurrency';

// DX-274 · Una salida de caja menor que se cruza con el cierre de su caja:
// o entra en esa caja ANTES del cierre (y el arqueo guardado la resta) o es un
// 409 sin dejar nada. Nunca queda una salida en una caja ya cerrada. Contra
// Postgres real, con los repositorios de la app y la caja tomada con FOR
// SHARE (salida) frente a FOR UPDATE (cierre).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const cashRepo = new PrismaCashSessionRepository(prisma, tenantContext);
const expenseRepo = new PrismaExpenseRepository(prisma, tenantContext);
const cashLink = new ExpenseCashSession(prisma, tenantContext);

const SUBDOMAIN = 'dx274-outflow-int';
const EMAIL = 'dx274-outflow-int@example.com';
const FLOAT = 100_000;
const AMOUNT = 12_500;
const ROUNDS = 5;

let tenantId: string;
let locationId: string;
let userId: string;

async function cleanup(): Promise<void> {
  const tenant = await raw.tenant.findFirst({
    where: { subdomain: SUBDOMAIN },
    select: { id: true },
  });
  if (tenant) {
    const where = { tenantId: tenant.id };
    await raw.cashSessionAdjustment.deleteMany({ where });
    await raw.expensePayment.deleteMany({ where });
    await raw.expense.deleteMany({ where });
    await raw.cashSessionReopening.deleteMany({ where });
    await raw.cashSessionClosingLine.deleteMany({ where });
    await raw.cashSessionClosing.deleteMany({ where });
    await raw.cashSessionFloat.deleteMany({ where });
    await raw.cashSession.deleteMany({ where });
    await raw.locationSchedule.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.delete({ where: { id: tenant.id } });
  }
  await raw.user.deleteMany({ where: { email: EMAIL } });
}

const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(tenantId, fn);

async function openSession(): Promise<string> {
  const opened = await inTenant(() =>
    cashRepo.open({
      locationId,
      openedById: userId,
      floats: [{ currency: 'COP', cents: FLOAT * 100 }],
      notes: null,
    }),
  );
  if (opened === 'ALREADY_OPEN') throw new Error('caja ya abierta');
  return opened.id;
}

/** El cierre de la app, contando exactamente lo esperado (sin diferencia). */
function closeSession(id: string, seen: ExpectedLine[][] = []) {
  return inTenant(() =>
    cashRepo.close(id, {}, userId, (context): ClosingDraft => {
      seen.push(context.expected);
      const result = arqueo(
        context.expected,
        context.expected.map((line) => ({
          currency: line.currency,
          method: line.method,
          cents: line.expectedCents,
        })),
      );
      return {
        lines: result.lines,
        hasDifference: false,
        differenceReason: null,
        notes: null,
        blind: context.blind,
        suggestedLockDate: '2026-10-23',
      };
    }),
  );
}

/** La salida de caja de la app: gasto + pago desde la caja, una transacción. */
function outflow(link: ExpenseCashLink = cashLink) {
  return inTenant(() =>
    expenseRepo.create(
      {
        locationId,
        category: 'Mensajería',
        supplier: 'Rappi',
        description: null,
        amount: AMOUNT,
        currency: 'COP',
        invoiceDate: '2026-10-23',
        dueDate: null,
        attachment: null,
        createdById: userId,
      },
      {
        amount: AMOUNT,
        method: 'CASH',
        paidOn: '2026-10-23',
        createdById: userId,
        cashLink: link,
      },
      new Date(),
    ),
  );
}

const cashLine = (lines: ExpectedLine[]) =>
  lines.find((l) => l.currency === 'COP' && l.method === 'CASH');

describe('salida de caja frente al cierre de su caja (int, DX-274)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    userId = (
      await raw.user.create({
        data: { email: EMAIL, passwordHash: 'x', fullName: 'Rita Recepción' },
      })
    ).id;
    tenantId = (
      await raw.tenant.create({
        data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
      })
    ).id;
    locationId = (
      await raw.location.create({
        data: { tenantId, name: 'Sede', country: 'CO' },
      })
    ).id;
    await raw.locationSchedule.create({
      data: { tenantId, locationId, timezone: 'Asia/Tokyo' },
    });
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  it('el cierre espera a la salida que ya tomó la caja y la resta en su arqueo', async () => {
    const sessionId = await openSession();
    const holding = gate<string>();
    const release = gate();
    // La salida toma la caja (FOR SHARE) y se queda dentro de su transacción.
    const pausedLink: ExpenseCashLink = {
      ...cashLink,
      openSessionLocations: (...args) => cashLink.openSessionLocations(...args),
      onPaymentVoided: (...args) => cashLink.onPaymentVoided(...args),
      attachToOpenSession: async (
        tx: Prisma.TransactionClient,
        ctx: ExpenseCashContext,
      ) => {
        const id = await cashLink.attachToOpenSession(tx, ctx);
        holding.open(await transactionId(tx));
        await release.wait;
        return id;
      },
    };
    const created = settle(outflow(pausedLink));
    const xid = await holding.wait;

    const seen: ExpectedLine[][] = [];
    const closed = settle(closeSession(sessionId, seen));
    await waitForTransactionWaiters(raw, xid);
    release.open();

    const [out, close] = await Promise.all([created, closed]);
    expect(out.status).toBe('fulfilled');
    expect(close).toEqual({ status: 'fulfilled', value: 'CLOSED' });
    expect(cashLine(seen[0])).toMatchObject({
      openingCents: FLOAT * 100,
      outflowsCents: AMOUNT * 100,
      outflowsCount: 1,
      expectedCents: (FLOAT - AMOUNT) * 100,
    });
    const line = await raw.cashSessionClosingLine.findFirstOrThrow({
      where: { closing: { sessionId }, currency: 'COP', method: 'CASH' },
    });
    expect(line.expected.toNumber()).toBe(FLOAT - AMOUNT);
  });

  it('la salida que llega con el cierre en curso ve la caja cerrada: 409 y no queda nada', async () => {
    const sessionId = await openSession();
    const before = await raw.expense.count({ where: { tenantId } });
    const locked = gate<string>();
    const finish = gate();
    // El cierre de la app, con la caja bloqueada (FOR UPDATE) hasta la señal.
    const closing = prisma.runWithTenant(tenantId, async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "cash_sessions" WHERE "id" = ${sessionId}::uuid
        FOR UPDATE`;
      locked.open(await transactionId(tx));
      await finish.wait;
      const row = await tx.cashSessionClosing.create({
        data: {
          tenantId,
          sessionId,
          sequence: 1,
          closedById: userId,
          blind: false,
          hasDifference: false,
          suggestedLockDate: new Date('2026-10-23T00:00:00.000Z'),
        },
      });
      await tx.cashSessionClosingLine.create({
        data: {
          tenantId,
          closingId: row.id,
          currency: 'COP',
          method: 'CASH',
          opening: FLOAT,
          expected: FLOAT,
          counted: FLOAT,
          difference: 0,
        },
      });
      await tx.cashSession.update({
        where: { id: sessionId },
        data: { status: 'CLOSED', closedById: userId },
      });
    });
    const xid = await locked.wait;
    const created = settle(outflow());
    await waitForTransactionWaiters(raw, xid);
    finish.open();
    await closing;

    const out = await created;
    expect(out.status).toBe('rejected');
    const reason = (out as { reason: unknown }).reason;
    expect(reason).toBeInstanceOf(ConflictException);
    expect((reason as ConflictException).message).toBe(
      OPEN_CASH_SESSION_REQUIRED_MESSAGE,
    );
    expect(await raw.expense.count({ where: { tenantId } })).toBe(before);
    expect(
      await raw.expensePayment.count({ where: { cashSessionId: sessionId } }),
    ).toBe(0);
  });

  it('una anulación que se cruza con el cierre: el cierre la cuenta y la anulación es OUTFLOW_VOID', async () => {
    const sessionId = await openSession();
    const created = await outflow();
    const paymentId = created.detail.payments[0].id;
    const updated = gate();
    const release = gate();
    // La anulación ya escribió `voidedAt` (sin COMMIT) y espera antes de
    // mirar la caja: el cierre no la ve y cuenta la salida.
    const pausedLink: ExpenseCashLink = {
      attachToOpenSession: (...args) => cashLink.attachToOpenSession(...args),
      openSessionLocations: (...args) => cashLink.openSessionLocations(...args),
      onPaymentVoided: async (...args) => {
        updated.open();
        await release.wait;
        return cashLink.onPaymentVoided(...args);
      },
    };
    const voiding = settle(
      inTenant(() =>
        expenseRepo.voidPayment(
          created.detail.id,
          paymentId,
          'Se cruzó con el cierre',
          userId,
          new Date(),
          pausedLink,
        ),
      ),
    );
    await updated.wait;
    const seen: ExpectedLine[][] = [];
    await expect(closeSession(sessionId, seen)).resolves.toBe('CLOSED');
    release.open();
    expect((await voiding).status).toBe('fulfilled');

    expect(cashLine(seen[0])).toMatchObject({
      outflowsCount: 1,
      expectedCents: (FLOAT - AMOUNT) * 100,
    });
    const adjustment = await raw.cashSessionAdjustment.findFirstOrThrow({
      where: { expensePaymentId: paymentId },
    });
    expect(adjustment).toMatchObject({
      kind: 'OUTFLOW_VOID',
      originalSessionId: sessionId,
      sessionId: null, // quien anula no tiene otra caja abierta: pendiente
    });
    expect(adjustment.amount.toNumber()).toBe(AMOUNT);
    // La caja cerrada sigue restándola (como en su cierre).
    const detail = await inTenant(() => cashRepo.detail(sessionId, {}));
    expect(detail?.expected?.find((l) => l.method === 'CASH')?.expected).toBe(
      FLOAT - AMOUNT,
    );
  });

  it(`en ${ROUNDS} carreras sin orden: o cuenta en el cierre o es 409; nunca en una caja cerrada`, async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const sessionId = await openSession();
      const seen: ExpectedLine[][] = [];
      const [out, close] = await Promise.all([
        settle(outflow()),
        settle(closeSession(sessionId, seen)),
      ]);
      expect(close).toEqual({ status: 'fulfilled', value: 'CLOSED' });
      const attached = await raw.expensePayment.count({
        where: { cashSessionId: sessionId },
      });
      if (out.status === 'fulfilled') {
        // Entró antes del cierre: el arqueo guardado la resta.
        expect(attached).toBe(1);
        expect(cashLine(seen[0])?.outflowsCount).toBe(1);
        expect(cashLine(seen[0])?.expectedCents).toBe((FLOAT - AMOUNT) * 100);
      } else {
        expect(out.reason).toBeInstanceOf(ConflictException);
        expect(attached).toBe(0);
        expect(cashLine(seen[0])?.outflowsCount).toBe(0);
      }
    }
  });
});
