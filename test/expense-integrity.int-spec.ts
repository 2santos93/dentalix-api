import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { prismaRuleCode } from '../src/shared/prisma/prisma-exception.filter';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-393 (auditoría DB-058), capa DB: la vida y el tope de los pagos de un
// gasto y la anulación de una salida de caja están en la BD, no solo en la
// app. Todo lo que se prueba va como dentalix_app (runWithTenant, bajo RLS) y
// SIN los bloqueos de la app: es la red que queda si una ruta se los salta.
// `raw` (DIRECT_URL, superusuario) siembra, siembra filas YA incoherentes
// (con los triggers apagados, como las que dejó el código anterior) y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const ROOT = join(__dirname, '..');
const SUBDOMAIN = 'dx393-int';
const EMAIL = 'dx393-int@example.com';
const DAY = new Date('2026-10-17T00:00:00.000Z');
const MIGRATIONS = [
  '20261105120000_dx393_expense_integrity',
  '20261105120100_dx393_expenses_list_idx',
];
const REPORT = join(ROOT, 'prisma/scripts/expense-integrity-report.sql');

/** psql no acepta el `?schema=public` de las URL de Prisma. */
function psqlUrl(): string {
  const url = new URL(process.env.DIRECT_URL ?? '');
  url.search = '';
  return url.toString();
}

let tenantId: string;
let locationId: string;
let userId: string;
let openSession: string;
let otherSession: string;
let thirdUserId: string;

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: SUBDOMAIN },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length > 0) {
    const where = { tenantId: { in: ids } };
    // Superusuario: los triggers de no-borrado dejan la purga administrativa.
    await raw.cashSessionAdjustment.deleteMany({ where });
    await raw.expensePayment.deleteMany({ where });
    await raw.expense.deleteMany({ where });
    await raw.cashSessionClosingLine.deleteMany({ where });
    await raw.cashSessionClosing.deleteMany({ where });
    await raw.cashSessionFloat.deleteMany({ where });
    await raw.cashSession.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  await raw.user.deleteMany({ where: { email: EMAIL } });
}

function asApp<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.runWithTenant(tenantId, fn);
}

/** El SQLSTATE con el que la BD rechaza `promise`. */
async function sqlState(
  promise: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return prismaRuleCode(error);
  }
  throw new Error('la BD aceptó la escritura');
}

const VOID = (reason = 'Registrado por error') => ({
  voidedAt: new Date(),
  voidedById: userId,
  voidReason: reason,
});

function newExpense(amount = 100) {
  return asApp((tx) =>
    tx.expense.create({
      data: {
        tenantId,
        locationId,
        category: 'Insumos clínicos',
        amount,
        currency: 'COP',
        invoiceDate: DAY,
        createdById: userId,
      },
    }),
  );
}

function paymentData(
  expenseId: string,
  amount: number,
  extra: Partial<Prisma.ExpensePaymentUncheckedCreateInput> = {},
): Prisma.ExpensePaymentUncheckedCreateInput {
  return {
    tenantId,
    expenseId,
    locationId,
    amount,
    currency: 'COP',
    method: 'TRANSFER',
    paidOn: DAY,
    createdById: userId,
    ...extra,
  };
}

function pay(
  expenseId: string,
  amount: number,
  extra: Partial<Prisma.ExpensePaymentUncheckedCreateInput> = {},
) {
  return asApp((tx) =>
    tx.expensePayment.create({ data: paymentData(expenseId, amount, extra) }),
  );
}

function openCash(openedById: string) {
  return asApp(async (tx) => {
    const session = await tx.cashSession.create({
      data: { tenantId, locationId, openedById },
    });
    await tx.cashSessionFloat.create({
      data: { tenantId, sessionId: session.id, currency: 'COP', amount: 0 },
    });
    return session.id;
  });
}

/** Cierra la caja como la app: cierre + línea + estado, en una transacción. */
function closeCash(sessionId: string) {
  return asApp(async (tx) => {
    const closing = await tx.cashSessionClosing.create({
      data: {
        tenantId,
        sessionId,
        sequence: 1,
        closedById: userId,
        blind: false,
        hasDifference: false,
        suggestedLockDate: DAY,
      },
    });
    await tx.cashSessionClosingLine.create({
      data: {
        tenantId,
        closingId: closing.id,
        currency: 'COP',
        method: 'CASH',
        opening: 0,
        expected: 0,
        counted: 0,
        difference: 0,
      },
    });
    await tx.cashSession.update({
      where: { id: sessionId },
      data: { status: 'CLOSED', closedById: userId },
    });
  });
}

describe('DX-393 · integridad entre gasto y pagos en la BD (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    const tenant = await raw.tenant.create({
      data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
    });
    tenantId = tenant.id;
    const location = await raw.location.create({
      data: locationData(REGIONAL_BOGOTA_FIXTURE, {
        tenantId,
        name: 'Sede',
        country: 'CO',
      }),
    });
    locationId = location.id;
    const user = await raw.user.create({
      data: { email: EMAIL, passwordHash: 'x', fullName: 'Ada Admin' },
    });
    userId = user.id;
    openSession = await openCash(userId);
    const other = await raw.user.create({
      data: {
        email: `otra-${EMAIL}`,
        passwordHash: 'x',
        fullName: 'Rita Recepción',
      },
    });
    otherSession = await openCash(other.id);
    const third = await raw.user.create({
      data: {
        email: `tercera-${EMAIL}`,
        passwordHash: 'x',
        fullName: 'Tere Turno',
      },
    });
    thirdUserId = third.id;
  });

  afterAll(async () => {
    await cleanup();
    await raw.user.deleteMany({
      where: { email: { in: [`otra-${EMAIL}`, `tercera-${EMAIL}`] } },
    });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  describe('la reproducción de la auditoría ya no pasa', () => {
    it('gasto de 100 y pago de 80: ni rebajar a 10, ni anular con el pago vivo, ni pagar 500 más', async () => {
      const e = await newExpense(100);
      await pay(e.id, 80);

      await expect(
        sqlState(
          asApp((tx) =>
            tx.expense.update({ where: { id: e.id }, data: { amount: 10 } }),
          ),
        ),
      ).resolves.toBe('Q3932');
      await expect(
        sqlState(
          asApp((tx) =>
            tx.expense.update({ where: { id: e.id }, data: VOID() }),
          ),
        ),
      ).resolves.toBe('Q3933');
      await expect(sqlState(pay(e.id, 500))).resolves.toBe('Q3931');

      const row = await raw.expense.findUniqueOrThrow({ where: { id: e.id } });
      expect(Number(row.amount)).toBe(100);
      expect(row.voidedAt).toBeNull();
    });

    it('un pago sobre un gasto anulado falla (Q3930), también por SQL crudo', async () => {
      const e = await newExpense(100);
      await asApp((tx) =>
        tx.expense.update({ where: { id: e.id }, data: VOID() }),
      );
      await expect(sqlState(pay(e.id, 1))).resolves.toBe('Q3930');
      await expect(
        sqlState(
          asApp(
            (tx) => tx.$executeRaw`
              INSERT INTO "expense_payments"
                ("id", "tenantId", "expenseId", "locationId", "amount", "currency",
                 "method", "paidOn", "createdById")
              VALUES (gen_random_uuid(), ${tenantId}::uuid, ${e.id}::uuid,
                ${locationId}::uuid, 1, 'COP', 'TRANSFER', ${DAY}, ${userId}::uuid)`,
          ),
        ),
      ).resolves.toBe('Q3930');
      await expect(
        raw.expensePayment.count({ where: { expenseId: e.id } }),
      ).resolves.toBe(0);
    });

    it('el mensaje de la BD es el texto en español del 409', async () => {
      const e = await newExpense(100);
      await pay(e.id, 80);
      await expect(
        asApp((tx) =>
          tx.expense.update({ where: { id: e.id }, data: { amount: 79.99 } }),
        ),
      ).rejects.toThrow(/El importe no puede ser menor a lo ya pagado/);
      await expect(pay(e.id, 20.01)).rejects.toThrow(
        /El pago supera lo pendiente del gasto/,
      );
    });
  });

  describe('lo coherente sigue entrando', () => {
    it('pagar hasta lo pendiente exacto, subir el importe y bajarlo hasta lo pagado', async () => {
      const e = await newExpense(100);
      await pay(e.id, 60);
      await pay(e.id, 40);
      await asApp((tx) =>
        tx.expense.update({ where: { id: e.id }, data: { amount: 150 } }),
      );
      await asApp((tx) =>
        tx.expense.update({ where: { id: e.id }, data: { amount: 100 } }),
      );
      // Cambiar otros campos no mira lo pagado.
      await asApp((tx) =>
        tx.expense.update({
          where: { id: e.id },
          data: { supplier: 'Dental Depot' },
        }),
      );
    });

    it('los pagos anulados no cuentan: liberan el importe y el tope', async () => {
      const e = await newExpense(100);
      const p = await pay(e.id, 100);
      await asApp((tx) =>
        tx.expensePayment.update({ where: { id: p.id }, data: VOID() }),
      );
      await asApp((tx) =>
        tx.expense.update({ where: { id: e.id }, data: { amount: 10 } }),
      );
      await pay(e.id, 10);
    });

    it('anular el gasto tras anular sus pagos en la MISMA transacción (lo que hace la app)', async () => {
      const e = await newExpense(100);
      const p = await pay(e.id, 30);
      const q = await pay(e.id, 20);
      await asApp(async (tx) => {
        for (const id of [p.id, q.id]) {
          await tx.expensePayment.update({ where: { id }, data: VOID() });
        }
        await tx.expense.update({ where: { id: e.id }, data: VOID() });
      });
      const row = await raw.expense.findUniqueOrThrow({ where: { id: e.id } });
      expect(row.voidedAt).not.toBeNull();
    });

    it('un pago de un gasto de otra clínica sigue fallando por la FK, no por la guarda', async () => {
      const foreign = await raw.tenant.create({
        data: { name: `${SUBDOMAIN}-b`, subdomain: `${SUBDOMAIN}-b` },
      });
      try {
        const loc = await raw.location.create({
          data: locationData(REGIONAL_BOGOTA_FIXTURE, {
            tenantId: foreign.id,
            name: 'Ajena',
            country: 'CO',
          }),
        });
        const e = await raw.expense.create({
          data: {
            tenantId: foreign.id,
            locationId: loc.id,
            category: 'Ajeno',
            amount: 100,
            currency: 'COP',
            invoiceDate: DAY,
            createdById: userId,
          },
        });
        await expect(sqlState(pay(e.id, 1))).resolves.toBe('23503');
      } finally {
        const where = { tenantId: foreign.id };
        await raw.expense.deleteMany({ where });
        await raw.location.deleteMany({ where });
        await raw.tenant.delete({ where: { id: foreign.id } });
      }
    });
  });

  describe('carreras sin el FOR UPDATE de la app', () => {
    /** Ejecuta `first` y, mientras su transacción sigue abierta, `second`. */
    async function race(
      first: (tx: Prisma.TransactionClient) => Promise<unknown>,
      second: () => Promise<unknown>,
    ): Promise<string | undefined> {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let started!: () => void;
      const inside = new Promise<void>((resolve) => (started = resolve));
      const t1 = asApp(async (tx) => {
        await first(tx);
        started();
        await held;
      });
      await inside;
      const t2 = sqlState(second());
      // t2 espera el bloqueo de la fila del gasto que tomó t1.
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      await t1;
      return t2;
    }

    it('dos pagos que juntos pasan el importe: el segundo espera y falla (Q3931)', async () => {
      const e = await newExpense(100);
      await expect(
        race(
          (tx) => tx.expensePayment.create({ data: paymentData(e.id, 60) }),
          () => pay(e.id, 60),
        ),
      ).resolves.toBe('Q3931');
      const live = await raw.expensePayment.aggregate({
        where: { expenseId: e.id, voidedAt: null },
        _sum: { amount: true },
      });
      expect(Number(live._sum.amount)).toBe(60);
    });

    it('un pago que se cruza con la anulación del gasto espera y falla (Q3930)', async () => {
      const e = await newExpense(100);
      await expect(
        race(
          (tx) => tx.expense.update({ where: { id: e.id }, data: VOID() }),
          () => pay(e.id, 10),
        ),
      ).resolves.toBe('Q3930');
    });

    it('una rebaja que se cruza con un pago espera y falla (Q3932)', async () => {
      const e = await newExpense(100);
      await expect(
        race(
          (tx) => tx.expensePayment.create({ data: paymentData(e.id, 50) }),
          () =>
            asApp((tx) =>
              tx.expense.update({ where: { id: e.id }, data: { amount: 40 } }),
            ),
        ),
      ).resolves.toBe('Q3932');
    });
  });

  describe('OUTFLOW_VOID exige el importe y la caja de la salida que anula', () => {
    /**
     * Salida de 10.000 de una caja que después se CIERRA (la única que se
     * devuelve con OUTFLOW_VOID, como `onPaymentVoided`); `voided` la anula.
     */
    async function outflow(voided = true) {
      const session = await openCash(thirdUserId);
      const e = await newExpense(50_000);
      const p = await pay(e.id, 10_000, {
        method: 'CASH',
        cashSessionId: session,
      });
      await closeCash(session);
      if (!voided) return p;
      return asApp((tx) =>
        tx.expensePayment.update({ where: { id: p.id }, data: VOID() }),
      );
    }

    function adjustment(
      payment: { id: string; cashSessionId: string | null },
      extra: Partial<Prisma.CashSessionAdjustmentUncheckedCreateInput> = {},
    ) {
      return asApp((tx) =>
        tx.cashSessionAdjustment.create({
          data: {
            tenantId,
            locationId,
            kind: 'OUTFLOW_VOID',
            expensePaymentId: payment.id,
            originalSessionId: payment.cashSessionId ?? openSession,
            currency: 'COP',
            method: 'CASH',
            amount: 10_000,
            reason: 'Salida registrada por error',
            createdById: userId,
            ...extra,
          },
        }),
      );
    }

    it('con el importe y la caja de su salida anulada, entra', async () => {
      const p = await outflow();
      await expect(adjustment(p)).resolves.toMatchObject({
        kind: 'OUTFLOW_VOID',
      });
    });

    it('otro importe, otra caja de origen o una salida aún viva: Q3934', async () => {
      const p = await outflow();
      await expect(sqlState(adjustment(p, { amount: 9_999 }))).resolves.toBe(
        'Q3934',
      );
      await expect(
        sqlState(adjustment(p, { amount: 10_000.01 })),
      ).resolves.toBe('Q3934');
      await expect(
        sqlState(adjustment(p, { originalSessionId: otherSession })),
      ).resolves.toBe('Q3934');
      const live = await outflow(false);
      await expect(sqlState(adjustment(live))).resolves.toBe('Q3934');
      await expect(
        raw.cashSessionAdjustment.count({
          where: { expensePaymentId: { in: [p.id, live.id] } },
        }),
      ).resolves.toBe(0);
    });

    it('una salida cuya caja sigue ABIERTA no se devuelve con un ajuste: contaría dos veces (Q3934)', async () => {
      // Anulada con su caja abierta, la salida ya deja de restar allí: un
      // OUTFLOW_VOID la sumaría otra vez (como si saliera dinero de más).
      const e = await newExpense(50_000);
      const p = await pay(e.id, 10_000, {
        method: 'CASH',
        cashSessionId: openSession,
      });
      const voided = await asApp((tx) =>
        tx.expensePayment.update({ where: { id: p.id }, data: VOID() }),
      );
      await expect(sqlState(adjustment(voided))).resolves.toBe('Q3934');
      await expect(
        sqlState(adjustment(voided, { sessionId: otherSession })),
      ).resolves.toBe('Q3934');
      await expect(
        raw.cashSessionAdjustment.count({ where: { expensePaymentId: p.id } }),
      ).resolves.toBe(0);
    });

    it('un pago sin caja no se puede «devolver» a una caja', async () => {
      const e = await newExpense(50_000);
      const p = await pay(e.id, 10_000, { method: 'CASH' });
      await asApp((tx) =>
        tx.expensePayment.update({ where: { id: p.id }, data: VOID() }),
      );
      await expect(sqlState(adjustment(p))).resolves.toBe('Q3934');
    });
  });

  describe('datos ya incoherentes: se informan, no se borran', () => {
    let voidedWithLive: string;
    let overPaid: string;
    let mismatched: string;
    let outflowExpense: string;

    beforeAll(async () => {
      // Como las dejaba el código anterior a DX-393: triggers apagados solo
      // en esta transacción del superusuario.
      await raw.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        const base = {
          tenantId,
          locationId,
          category: 'Incoherente',
          currency: 'COP',
          invoiceDate: DAY,
          createdById: userId,
        };
        const a = await tx.expense.create({
          data: { ...base, amount: 10, ...VOID('Anulado con pagos') },
        });
        await tx.expensePayment.create({ data: paymentData(a.id, 80) });
        await tx.expensePayment.create({ data: paymentData(a.id, 500) });
        voidedWithLive = a.id;
        const b = await tx.expense.create({ data: { ...base, amount: 10 } });
        await tx.expensePayment.create({ data: paymentData(b.id, 25) });
        overPaid = b.id;
        const c = await tx.expense.create({ data: { ...base, amount: 100 } });
        outflowExpense = c.id;
        const out = await tx.expensePayment.create({
          data: paymentData(c.id, 70, {
            method: 'CASH',
            cashSessionId: openSession,
          }),
        });
        const adj = await tx.cashSessionAdjustment.create({
          data: {
            tenantId,
            locationId,
            kind: 'OUTFLOW_VOID',
            expensePaymentId: out.id,
            originalSessionId: otherSession,
            currency: 'COP',
            method: 'CASH',
            amount: 7,
            reason: 'Ajuste incoherente',
            createdById: userId,
          },
        });
        mismatched = adj.id;
      });
    });

    it('la consulta de diagnóstico los lista con sus importes y sin datos del gasto', async () => {
      const rows = await raw.$queryRawUnsafe<
        {
          problem: string;
          tenantId: string;
          expenseId: string;
          rowId: string | null;
          expected: Prisma.Decimal;
          actual: Prisma.Decimal;
        }[]
      >(readFileSync(REPORT, 'utf8'));
      const mine = rows
        .filter((r) => r.tenantId === tenantId)
        .map((r) => ({
          problem: r.problem,
          expenseId: r.expenseId,
          rowId: r.rowId,
          expected: Number(r.expected),
          actual: Number(r.actual),
        }));
      expect(mine).toEqual(
        expect.arrayContaining([
          {
            problem: 'VOIDED_WITH_LIVE_PAYMENTS',
            expenseId: voidedWithLive,
            rowId: null,
            expected: 10,
            actual: 580,
          },
          {
            problem: 'PAID_OVER_AMOUNT',
            expenseId: voidedWithLive,
            rowId: null,
            expected: 10,
            actual: 580,
          },
          {
            problem: 'PAID_OVER_AMOUNT',
            expenseId: overPaid,
            rowId: null,
            expected: 10,
            actual: 25,
          },
          {
            problem: 'OUTFLOW_VOID_MISMATCH',
            expenseId: outflowExpense,
            rowId: mismatched,
            expected: 70,
            actual: 7,
          },
        ]),
      );
      // Lo coherente de los otros casos de este spec no sale.
      expect(mine).toHaveLength(4);
      expect(Object.keys(rows[0]).sort()).toEqual(
        [
          'actual',
          'expected',
          'expenseId',
          'locationId',
          'problem',
          'rowId',
          'tenantId',
        ].sort(),
      );
    });

    it('sin BYPASSRLS (dentalix_app, o un owner NOBYPASSRLS) no da un falso «todo bien»', async () => {
      // FORCE RLS: sin clínica fijada no ve ningún gasto; el informe lo dice
      // con una fila propia en vez de devolver 0 filas.
      const app = new PrismaClient<Prisma.PrismaClientOptions>({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });
      try {
        const rows = await app.$queryRawUnsafe<
          { problem: string; tenantId: string | null }[]
        >(readFileSync(REPORT, 'utf8'));
        expect(rows).toEqual([
          expect.objectContaining({
            problem: 'ROLE_WITHOUT_BYPASSRLS',
            tenantId: null,
          }),
        ]);
      } finally {
        await app.$disconnect();
      }
    });

    it('las migraciones de DX-393 se aplican igual con esas filas y no las tocan', () => {
      for (const migration of MIGRATIONS) {
        execFileSync(
          'psql',
          [
            psqlUrl(),
            '-X',
            '-q',
            '-v',
            'ON_ERROR_STOP=1',
            '-1',
            '-f',
            join(ROOT, 'prisma/migrations', migration, 'migration.sql'),
          ],
          { stdio: 'pipe' },
        );
      }
      return expect(
        Promise.all([
          raw.expensePayment.count({
            where: { expenseId: voidedWithLive, voidedAt: null },
          }),
          raw.cashSessionAdjustment.count({ where: { id: mismatched } }),
        ]),
      ).resolves.toEqual([2, 1]);
    });

    it('se corrigen anulando los pagos que sobran; el gasto sigue sin poder rebajarse', async () => {
      const live = await raw.expensePayment.findMany({
        where: { expenseId: overPaid, voidedAt: null },
      });
      await expect(
        sqlState(
          asApp((tx) =>
            tx.expense.update({ where: { id: overPaid }, data: { amount: 5 } }),
          ),
        ),
      ).resolves.toBe('Q3932');
      for (const p of live) {
        await asApp((tx) =>
          tx.expensePayment.update({ where: { id: p.id }, data: VOID() }),
        );
      }
      await asApp((tx) =>
        tx.expense.update({ where: { id: overPaid }, data: { amount: 5 } }),
      );
    });
  });
});
