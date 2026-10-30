import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-274, capa DB: gastos de la sede y salidas de caja menor. RLS FORCE en las
// tres tablas, FK compuestas por clínica (el pago hereda sede y moneda del
// gasto), CHECK «con caja => efectivo», un pago con caja solo entra en una caja
// ABIERTA de su sede y no la cambia nunca, sin DELETE, la anulación se fija una
// vez, el soporte no cambia, y el ajuste OUTFLOW_VOID de la caja (CHECK, índice
// único y validación de pertenencia). Lo que se prueba va por la MISMA ruta que
// la app (runWithTenant, rol dentalix_app, sujeto a RLS); `raw` (DIRECT_URL,
// superusuario) siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAINS = ['dx274-int-a', 'dx274-int-b'];
const EMAILS = [
  'dx274-int-1@example.com',
  'dx274-int-2@example.com',
  'dx274-int-3@example.com',
];
const FK_VIOLATION = { code: 'P2003' };
const DAY = new Date('2026-10-17T00:00:00.000Z');
const TABLES = ['expense_categories', 'expenses', 'expense_payments'];

interface Clinic {
  tenantId: string;
  locationId: string;
  otherLocationId: string;
}

let userId: string;
let otherUserId: string;
let thirdUserId: string;

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const location = await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId,
      name: 'Sede',
      country: 'CO',
    }),
  });
  const other = await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId,
      name: 'Sede Norte',
      country: 'CO',
    }),
  });
  return { tenantId, locationId: location.id, otherLocationId: other.id };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const where = { tenantId: { in: ids } };
  // Superusuario: los triggers de no-borrado dejan la purga administrativa.
  await raw.cashSessionAdjustment.deleteMany({ where });
  await raw.expensePayment.deleteMany({ where });
  await raw.expense.deleteMany({ where });
  await raw.expenseCategory.deleteMany({ where });
  await raw.cashSessionReopening.deleteMany({ where });
  await raw.cashSessionClosingLine.deleteMany({ where });
  await raw.cashSessionClosing.deleteMany({ where });
  await raw.cashSessionFloat.deleteMany({ where });
  await raw.cashSession.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
}

describe('gastos, pagos de gasto y salidas de caja: tablas, RLS e inmutabilidad (int, DX-274)', () => {
  let a: Clinic;
  let b: Clinic;
  /** Cajas de A: abierta en la sede, abierta en la otra sede y cerrada. */
  let openSession: string;
  let otherLocationSession: string;
  let closedSession: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    await raw.user.deleteMany({ where: { email: { in: EMAILS } } });
    [userId, otherUserId, thirdUserId] = await Promise.all(
      EMAILS.map(async (email) => {
        const user = await raw.user.create({
          data: { email, passwordHash: 'x', fullName: 'Rita Recepción' },
        });
        return user.id;
      }),
    );
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
    openSession = (await open(a.locationId, userId)).id;
    otherLocationSession = (await open(a.otherLocationId, userId)).id;
    closedSession = (await open(a.locationId, otherUserId)).id;
    await close(closedSession);
  });

  afterAll(async () => {
    await cleanup();
    await raw.user.deleteMany({ where: { email: { in: EMAILS } } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  /** Abre una caja en A como la app: sesión + fondo en la MISMA transacción. */
  function open(locationId: string, openedById: string) {
    return asA(async (tx) => {
      const session = await tx.cashSession.create({
        data: { tenantId: a.tenantId, locationId, openedById },
      });
      await tx.cashSessionFloat.create({
        data: {
          tenantId: a.tenantId,
          sessionId: session.id,
          currency: 'COP',
          amount: 50_000,
        },
      });
      return session;
    });
  }

  /** Cierra como la app: cierre + líneas + estado, en una transacción. */
  function close(sessionId: string) {
    return asA(async (tx) => {
      const closing = await tx.cashSessionClosing.create({
        data: {
          tenantId: a.tenantId,
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
          tenantId: a.tenantId,
          closingId: closing.id,
          currency: 'COP',
          method: 'CASH',
          opening: 50_000,
          expected: 50_000,
          counted: 50_000,
          difference: 0,
        },
      });
      await tx.cashSession.update({
        where: { id: sessionId },
        data: { status: 'CLOSED', closedById: userId },
      });
    });
  }

  /** Gasto sembrado por el superusuario (no es lo que se prueba). */
  function expense(
    clinic: Clinic,
    extra: Partial<Prisma.ExpenseUncheckedCreateInput> = {},
    locationId = clinic.locationId,
  ) {
    return raw.expense.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        category: 'Insumos clínicos',
        amount: 100_000,
        currency: 'COP',
        invoiceDate: DAY,
        createdById: userId,
        ...extra,
      },
    });
  }

  function paymentData(
    clinic: Clinic,
    expenseId: string,
    extra: Partial<Prisma.ExpensePaymentUncheckedCreateInput> = {},
  ): Prisma.ExpensePaymentUncheckedCreateInput {
    return {
      tenantId: clinic.tenantId,
      expenseId,
      locationId: clinic.locationId,
      amount: 10_000,
      currency: 'COP',
      method: 'TRANSFER',
      paidOn: DAY,
      createdById: userId,
      ...extra,
    };
  }

  /** Pago de A, como la app lo registra. */
  async function pay(
    extra: Partial<Prisma.ExpensePaymentUncheckedCreateInput> = {},
    expenseExtra: Partial<Prisma.ExpenseUncheckedCreateInput> = {},
  ) {
    const e = await expense(a, expenseExtra);
    const p = await asA((tx) =>
      tx.expensePayment.create({ data: paymentData(a, e.id, extra) }),
    );
    return { expense: e, payment: p };
  }

  describe.each(TABLES)('%s', (table) => {
    it('tiene RLS ENABLE + FORCE y la política del tenant', async () => {
      const rows = await raw.$queryRawUnsafe<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '"${table}"'::regclass`,
      );
      expect(rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
      const policies = await raw.$queryRaw<{ policyname: string }[]>`
        SELECT policyname FROM pg_policies WHERE tablename = ${table}`;
      expect(policies.map((p) => p.policyname)).toEqual(['tenant_isolation']);
    });
  });

  it('cada clínica ve solo lo suyo y no escribe en otra', async () => {
    const foreign = await expense(b);
    await raw.expenseCategory.create({
      data: { tenantId: b.tenantId, name: 'Ajena', createdById: userId },
    });
    await raw.expensePayment.create({ data: paymentData(b, foreign.id) });
    expect(await asA((tx) => tx.expense.findMany())).toEqual([]);
    expect(await asA((tx) => tx.expenseCategory.findMany())).toEqual([]);
    expect(await asA((tx) => tx.expensePayment.findMany())).toEqual([]);
    await expect(
      asA((tx) =>
        tx.expenseCategory.create({
          data: { tenantId: b.tenantId, name: 'Intrusa', createdById: userId },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asA((tx) =>
        tx.expense.create({
          data: {
            tenantId: b.tenantId,
            locationId: b.locationId,
            category: 'Otros',
            amount: 1,
            currency: 'COP',
            invoiceDate: DAY,
            createdById: userId,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('FK compuesta: ni la sede ni el gasto de otra clínica', async () => {
    await expect(
      asA((tx) =>
        tx.expense.create({
          data: {
            tenantId: a.tenantId,
            locationId: b.locationId,
            category: 'Otros',
            amount: 1,
            currency: 'COP',
            invoiceDate: DAY,
            createdById: userId,
          },
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
    const foreign = await expense(b);
    await expect(
      asA((tx) =>
        tx.expensePayment.create({
          data: paymentData(a, foreign.id, {
            locationId: foreign.locationId,
          }),
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('el pago hereda la sede y la moneda del gasto (FK compuesta de cuatro columnas)', async () => {
    const e = await expense(a);
    await expect(
      asA((tx) =>
        tx.expensePayment.create({
          data: paymentData(a, e.id, { locationId: a.otherLocationId }),
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
    await expect(
      asA((tx) =>
        tx.expensePayment.create({
          data: paymentData(a, e.id, { currency: 'USD' }),
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
    // La sede o la moneda de un gasto con pagos no cambian ni por la puerta de atrás.
    await asA((tx) => tx.expensePayment.create({ data: paymentData(a, e.id) }));
    await expect(
      raw.expense.update({
        where: { id: e.id },
        data: { currency: 'USD' },
      }),
    ).rejects.toMatchObject(FK_VIOLATION);
    await expect(
      raw.expense.update({
        where: { id: e.id },
        data: { locationId: a.otherLocationId },
      }),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('CHECK de importes y fechas del gasto y del pago', async () => {
    await expect(expense(a, { amount: 0 })).rejects.toThrow(
      /expenses_amount_check/,
    );
    await expect(
      expense(a, { dueDate: new Date('2026-10-01T00:00:00.000Z') }),
    ).rejects.toThrow(/expenses_due_date_check/);
    await expect(expense(a, { category: 'x' })).rejects.toThrow(
      /expenses_category_check/,
    );
    const e = await expense(a);
    await expect(
      asA((tx) =>
        tx.expensePayment.create({ data: paymentData(a, e.id, { amount: 0 }) }),
      ),
    ).rejects.toThrow(/expense_payments_amount_check/);
  });

  it('categorías: nombre de 2 a 60 y único entre las vivas de la clínica', async () => {
    const create = (name: string) =>
      asA((tx) =>
        tx.expenseCategory.create({
          data: { tenantId: a.tenantId, name, createdById: userId },
        }),
      );
    await expect(create('x')).rejects.toThrow(/expense_categories_name_check/);
    const first = await create('Mantenimiento locativo');
    await expect(create('Mantenimiento locativo')).rejects.toMatchObject({
      code: 'P2002',
    });
    // Retirada (deletedAt), el nombre queda libre; en la otra clínica nunca chocó.
    await asA((tx) =>
      tx.expenseCategory.update({
        where: { id: first.id },
        data: { deletedAt: new Date() },
      }),
    );
    await create('Mantenimiento locativo');
    // Sin mayúsculas, tildes ni espacios de más: «Café» y « cafe » son la misma.
    await create('Café del consultorio');
    await expect(create('  CAFE   del  consultorio ')).rejects.toMatchObject({
      code: 'P2002',
    });
    await expect(
      raw.expenseCategory.create({
        data: {
          tenantId: b.tenantId,
          name: 'Mantenimiento locativo',
          createdById: userId,
        },
      }),
    ).resolves.toBeDefined();
  });

  describe('pago con caja (salida de caja)', () => {
    it('CHECK: con cashSessionId el método es efectivo', async () => {
      const e = await expense(a);
      await expect(
        asA((tx) =>
          tx.expensePayment.create({
            data: paymentData(a, e.id, {
              method: 'CARD',
              cashSessionId: openSession,
            }),
          }),
        ),
      ).rejects.toThrow(/expense_payments_cash_method_check/);
      const ok = await asA((tx) =>
        tx.expensePayment.create({
          data: paymentData(a, e.id, {
            method: 'CASH',
            cashSessionId: openSession,
          }),
        }),
      );
      expect(ok.cashSessionId).toBe(openSession);
      // Sin caja, cualquier método.
      await asA((tx) =>
        tx.expensePayment.create({
          data: paymentData(a, e.id, { method: 'CASH' }),
        }),
      );
    });

    it('solo entra en una caja ABIERTA de su sede', async () => {
      const e = await expense(a);
      const cash = (cashSessionId: string) =>
        asA((tx) =>
          tx.expensePayment.create({
            data: paymentData(a, e.id, { method: 'CASH', cashSessionId }),
          }),
        );
      await expect(cash(closedSession)).rejects.toThrow(
        /caja abierta de su sede/,
      );
      await expect(cash(otherLocationSession)).rejects.toThrow(
        /caja abierta de su sede/,
      );
      // La caja de otra clínica no existe para A bajo RLS.
      const foreign = await raw.cashSession.create({
        data: {
          tenantId: b.tenantId,
          locationId: b.locationId,
          openedById: userId,
        },
      });
      await expect(cash(foreign.id)).rejects.toThrow(/caja abierta de su sede/);
    });

    it('cashSessionId no cambia nunca (ni a otra caja ni a NULL ni desde NULL)', async () => {
      const { payment } = await pay({
        method: 'CASH',
        cashSessionId: openSession,
      });
      const update = (data: Prisma.ExpensePaymentUncheckedUpdateInput) =>
        asA((tx) =>
          tx.expensePayment.update({ where: { id: payment.id }, data }),
        );
      await expect(update({ cashSessionId: null })).rejects.toThrow(
        /inalterable/,
      );
      const free = await pay({ method: 'CASH' });
      await expect(
        asA((tx) =>
          tx.expensePayment.update({
            where: { id: free.payment.id },
            data: { cashSessionId: openSession },
          }),
        ),
      ).rejects.toThrow(/inalterable/);
    });
  });

  describe('inmutabilidad del pago', () => {
    it('sin DELETE ni TRUNCATE para la app', async () => {
      const { payment } = await pay();
      await expect(
        asA(
          (tx) =>
            tx.$executeRaw`DELETE FROM "expense_payments" WHERE "id" = ${payment.id}::uuid`,
        ),
      ).rejects.toThrow(/no admite/);
      await expect(
        asA((tx) => tx.$executeRaw`TRUNCATE "expense_payments"`),
      ).rejects.toThrow(/permission denied|no admite/);
      // El superusuario (limpieza de tests) sí.
      await expect(
        raw.expensePayment.delete({ where: { id: payment.id } }),
      ).resolves.toBeDefined();
    });

    it('la clave de idempotencia del pago no se reescribe, ni al anularlo', async () => {
      const { payment } = await pay();
      await expect(
        asA((tx) =>
          tx.expensePayment.update({
            where: { id: payment.id },
            data: {
              idempotencyFingerprint: 'otra',
              voidedAt: new Date(),
              voidedById: userId,
              voidReason: 'Pago repetido',
            },
          }),
        ),
      ).rejects.toThrow(/inalterable/);
    });

    it('lo único que se edita es la anulación, y una sola vez', async () => {
      const { payment } = await pay();
      await expect(
        asA((tx) =>
          tx.expensePayment.update({
            where: { id: payment.id },
            data: { amount: 1 },
          }),
        ),
      ).rejects.toThrow(/inalterable/);
      // Anular incompleto: falla el CHECK (motivo de al menos 5).
      await expect(
        asA((tx) =>
          tx.expensePayment.update({
            where: { id: payment.id },
            data: {
              voidedAt: new Date(),
              voidedById: userId,
              voidReason: 'no',
            },
          }),
        ),
      ).rejects.toThrow(/expense_payments_void_check/);
      // Anular y, a la vez, tocar otra cosa: no.
      await expect(
        asA((tx) =>
          tx.expensePayment.update({
            where: { id: payment.id },
            data: {
              amount: 1,
              voidedAt: new Date(),
              voidedById: userId,
              voidReason: 'Pago duplicado',
            },
          }),
        ),
      ).rejects.toThrow(/inalterable/);
      const voided = await asA((tx) =>
        tx.expensePayment.update({
          where: { id: payment.id },
          data: {
            voidedAt: new Date(),
            voidedById: userId,
            voidReason: 'Pago duplicado',
          },
        }),
      );
      expect(voided.voidedAt).not.toBeNull();
      await expect(
        asA((tx) =>
          tx.expensePayment.update({
            where: { id: payment.id },
            data: { voidReason: 'Otro motivo distinto' },
          }),
        ),
      ).rejects.toThrow(/inalterable/);
      await expect(
        asA((tx) =>
          tx.expensePayment.update({
            where: { id: payment.id },
            data: { voidedAt: null, voidedById: null, voidReason: null },
          }),
        ),
      ).rejects.toThrow(/inalterable/);
    });

    it('anular la salida de una caja ya cerrada es posible (la caja no se reexamina)', async () => {
      const session = await open(a.locationId, thirdUserId);
      const e = await expense(a);
      const p = await asA((tx) =>
        tx.expensePayment.create({
          data: paymentData(a, e.id, {
            method: 'CASH',
            cashSessionId: session.id,
          }),
        }),
      );
      await close(session.id);
      const voided = await asA((tx) =>
        tx.expensePayment.update({
          where: { id: p.id },
          data: {
            voidedAt: new Date(),
            voidedById: userId,
            voidReason: 'Salida registrada por error',
          },
        }),
      );
      expect(voided.cashSessionId).toBe(session.id);
      expect(voided.voidedAt).not.toBeNull();
    });

    it('un pago nace sin anular', async () => {
      const e = await expense(a);
      await expect(
        asA((tx) =>
          tx.expensePayment.create({
            data: paymentData(a, e.id, {
              voidedAt: new Date(),
              voidedById: userId,
              voidReason: 'Nace anulado',
            }),
          }),
        ),
      ).rejects.toThrow(/nace sin anular/);
    });
  });

  describe('inmutabilidad del gasto', () => {
    it('sin DELETE ni TRUNCATE para la app; el superusuario sí', async () => {
      const e = await expense(a);
      await expect(
        asA(
          (tx) =>
            tx.$executeRaw`DELETE FROM "expenses" WHERE "id" = ${e.id}::uuid`,
        ),
      ).rejects.toThrow(/no admite/);
      await expect(
        asA((tx) => tx.$executeRaw`TRUNCATE "expenses"`),
      ).rejects.toThrow(/permission denied|no admite/);
      await expect(
        raw.expense.delete({ where: { id: e.id } }),
      ).resolves.toBeDefined();
    });

    it('el soporte se fija una vez (vacío a lleno) y no cambia después', async () => {
      const e = await expense(a);
      const support = {
        attachmentKey: `expense-receipts/${a.tenantId}/${e.id}/factura.pdf`,
        attachmentMime: 'application/pdf',
        attachmentSize: 2048,
        attachmentSha256: 'a'.repeat(64),
        attachmentName: 'factura.pdf',
      };
      // Incompleto: falla el CHECK.
      await expect(
        asA((tx) =>
          tx.expense.update({
            where: { id: e.id },
            data: { attachmentKey: support.attachmentKey },
          }),
        ),
      ).rejects.toThrow(/expenses_attachment_check/);
      await asA((tx) =>
        tx.expense.update({ where: { id: e.id }, data: support }),
      );
      for (const change of [
        { attachmentKey: `${support.attachmentKey}.bak` },
        { attachmentSha256: 'b'.repeat(64) },
        { attachmentName: 'otra.pdf' },
      ]) {
        await expect(
          asA((tx) =>
            tx.expense.update({
              where: { id: e.id },
              data: { ...support, ...change },
            }),
          ),
        ).rejects.toThrow(/soporte/);
      }
      await expect(
        asA((tx) =>
          tx.expense.update({
            where: { id: e.id },
            data: {
              attachmentKey: null,
              attachmentMime: null,
              attachmentSize: null,
              attachmentSha256: null,
              attachmentName: null,
            },
          }),
        ),
      ).rejects.toThrow(/soporte/);
      // Lo demás del gasto sí se edita.
      await asA((tx) =>
        tx.expense.update({
          where: { id: e.id },
          data: { supplier: 'Dental Depot', description: 'Guantes' },
        }),
      );
    });

    it('la anulación se fija una vez, con motivo, y no se deshace', async () => {
      const e = await expense(a);
      await expect(
        asA((tx) =>
          tx.expense.update({
            where: { id: e.id },
            data: {
              voidedAt: new Date(),
              voidedById: userId,
              voidReason: 'no',
            },
          }),
        ),
      ).rejects.toThrow(/expenses_void_check/);
      await asA((tx) =>
        tx.expense.update({
          where: { id: e.id },
          data: {
            voidedAt: new Date(),
            voidedById: userId,
            voidReason: 'Factura duplicada',
          },
        }),
      );
      await expect(
        asA((tx) =>
          tx.expense.update({
            where: { id: e.id },
            data: { voidReason: 'Otro motivo distinto' },
          }),
        ),
      ).rejects.toThrow(/no se anula de nuevo/);
      await expect(
        asA((tx) =>
          tx.expense.update({
            where: { id: e.id },
            data: { voidedAt: null, voidedById: null, voidReason: null },
          }),
        ),
      ).rejects.toThrow(/no se anula de nuevo/);
    });

    it('la clave de idempotencia y su huella no se reescriben', async () => {
      const e = await expense(a);
      await expect(
        asA((tx) =>
          tx.expense.update({
            where: { id: e.id },
            data: { idempotencyKey: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
          }),
        ),
      ).rejects.toThrow(/inalterable/);
      await expect(
        asA((tx) =>
          tx.expense.update({
            where: { id: e.id },
            data: { idempotencyFingerprint: 'otra' },
          }),
        ),
      ).rejects.toThrow(/inalterable/);
    });

    it('la clínica, el autor y el alta no cambian', async () => {
      const e = await expense(a);
      await expect(
        asA((tx) =>
          tx.expense.update({
            where: { id: e.id },
            data: { createdById: otherUserId },
          }),
        ),
      ).rejects.toThrow(/inalterable/);
    });
  });

  describe('OUTFLOW_VOID en los ajustes de caja', () => {
    /**
     * Una salida de la caja ABIERTA, ya anulada (como la app, antes del
     * ajuste): el ajuste la devuelve con su importe y contra su caja.
     */
    async function outflow() {
      const { payment } = await pay({
        method: 'CASH',
        cashSessionId: openSession,
      });
      return asA((tx) =>
        tx.expensePayment.update({
          where: { id: payment.id },
          data: {
            voidedAt: new Date(),
            voidedById: userId,
            voidReason: 'Salida registrada por error',
          },
        }),
      );
    }

    function adjustment(
      payment: { id: string },
      extra: Partial<Prisma.CashSessionAdjustmentUncheckedCreateInput> = {},
    ): Prisma.CashSessionAdjustmentUncheckedCreateInput {
      return {
        tenantId: a.tenantId,
        locationId: a.locationId,
        kind: 'OUTFLOW_VOID',
        expensePaymentId: payment.id,
        originalSessionId: openSession,
        currency: 'COP',
        method: 'CASH',
        amount: 10_000,
        reason: 'Salida registrada por error',
        createdById: userId,
        ...extra,
      };
    }

    const create = (data: Prisma.CashSessionAdjustmentUncheckedCreateInput) =>
      asA((tx) => tx.cashSessionAdjustment.create({ data }));

    it('acepta la anulación válida: positiva, de efectivo, con motivo y caja original', async () => {
      const p = await outflow();
      // Pendiente (sin caja destino).
      const pending = await create(adjustment(p));
      expect(pending.sessionId).toBeNull();
      expect(Number(pending.amount)).toBe(10_000);
      // En la caja abierta de quien anula.
      const q = await outflow();
      const joined = await create(adjustment(q, { sessionId: openSession }));
      expect(joined.sessionId).toBe(openSession);
    });

    it('CHECK: OUTFLOW_VOID exige la salida, importe > 0, caja original, motivo y efectivo, sin abono', async () => {
      const p = await outflow();
      const bad: Partial<Prisma.CashSessionAdjustmentUncheckedCreateInput>[] = [
        { expensePaymentId: null },
        { reason: null },
        { method: 'CARD' },
      ];
      for (const extra of bad) {
        await expect(create(adjustment(p, extra))).rejects.toThrow(
          /cash_session_adjustments_kind_check/,
        );
      }
      // Importe ≤ 0 o sin caja original: ya no es el de su salida, y la
      // guarda de DX-393 lo para antes que el CHECK.
      const notItsOutflow: Partial<Prisma.CashSessionAdjustmentUncheckedCreateInput>[] =
        [{ amount: -10_000 }, { amount: 0 }, { originalSessionId: null }];
      for (const extra of notItsOutflow) {
        await expect(create(adjustment(p, extra))).rejects.toThrow(
          /no coincide con su importe o con su caja/,
        );
      }
      const plan = await raw.patient.create({
        data: { tenantId: a.tenantId, firstName: 'Ana', lastName: 'Chk' },
      });
      const treatment = await raw.treatmentPlan.create({
        data: {
          tenantId: a.tenantId,
          patientId: plan.id,
          status: 'ACCEPTED',
          currency: 'COP',
        },
      });
      const abono = await raw.payment.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          treatmentPlanId: treatment.id,
          patientId: plan.id,
          amount: 5_000,
          currency: 'COP',
          paidAt: new Date(),
          method: 'CASH',
          createdById: userId,
        },
      });
      await expect(
        create(adjustment(p, { paymentId: abono.id })),
      ).rejects.toThrow(/cash_session_adjustments_kind_check/);
      // Limpieza del abono para no estorbar a otros casos del suite.
      await raw.payment.deleteMany({ where: { id: abono.id } });
      await raw.treatmentPlan.deleteMany({ where: { id: treatment.id } });
      await raw.patient.deleteMany({ where: { id: plan.id } });
    });

    it('CHECK: los demás kinds no admiten expensePaymentId', async () => {
      const p = await outflow();
      // Un abono real: VOID y LATE_PAYMENT fallan solo por expensePaymentId.
      const patient = await raw.patient.create({
        data: { tenantId: a.tenantId, firstName: 'Ana', lastName: 'Kinds' },
      });
      const treatment = await raw.treatmentPlan.create({
        data: {
          tenantId: a.tenantId,
          patientId: patient.id,
          status: 'ACCEPTED',
          currency: 'COP',
        },
      });
      const abono = await raw.payment.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          treatmentPlanId: treatment.id,
          patientId: patient.id,
          amount: 5_000,
          currency: 'COP',
          paidAt: new Date(),
          method: 'CASH',
          createdById: userId,
        },
      });
      try {
        // Control: sin expensePaymentId el mismo VOID es válido.
        await expect(
          create(
            adjustment(p, {
              kind: 'VOID',
              paymentId: abono.id,
              expensePaymentId: null,
              amount: -10,
            }),
          ),
        ).resolves.toBeDefined();
        await expect(
          create(adjustment(p, { kind: 'CORRECTION', amount: 10 })),
        ).rejects.toThrow(/cash_session_adjustments_kind_check/);
        await expect(
          create(
            adjustment(p, { kind: 'VOID', paymentId: abono.id, amount: -10 }),
          ),
        ).rejects.toThrow(/cash_session_adjustments_kind_check/);
        await expect(
          create(adjustment(p, { kind: 'LATE_PAYMENT', paymentId: abono.id })),
        ).rejects.toThrow(/cash_session_adjustments_kind_check/);
      } finally {
        await raw.cashSessionAdjustment.deleteMany({
          where: { paymentId: abono.id },
        });
        await raw.payment.deleteMany({ where: { id: abono.id } });
        await raw.treatmentPlan.deleteMany({ where: { id: treatment.id } });
        await raw.patient.deleteMany({ where: { id: patient.id } });
      }
      // CORRECTION sin salida sigue valiendo como en DX-027.
      await expect(
        create(
          adjustment(p, {
            kind: 'CORRECTION',
            expensePaymentId: null,
            amount: 10,
          }),
        ),
      ).resolves.toBeDefined();
    });

    it('índice único: una salida se anula en caja una sola vez', async () => {
      const p = await outflow();
      await create(adjustment(p));
      await expect(create(adjustment(p))).rejects.toMatchObject({
        code: 'P2002',
      });
    });

    it('el trigger exige que la salida sea de la clínica y de la sede del ajuste', async () => {
      const p = await outflow();
      // SQL crudo: Prisma pierde el mensaje de un foreign_key_violation, y así
      // se distingue el trigger de la FK compuesta.
      const insert = (
        tenantId: string,
        locationId: string,
        expensePaymentId: string,
        originalSessionId: string,
      ) =>
        asA(
          (tx) => tx.$executeRaw`
            INSERT INTO "cash_session_adjustments"
              ("id", "tenantId", "locationId", "kind", "expensePaymentId",
               "originalSessionId", "currency", "method", "amount", "reason",
               "createdById")
            VALUES (gen_random_uuid(), ${tenantId}::uuid, ${locationId}::uuid,
              'OUTFLOW_VOID', ${expensePaymentId}::uuid,
              ${originalSessionId}::uuid, 'COP', 'CASH', 10000,
              'Salida registrada por error', ${userId}::uuid)`,
        );
      // Otra sede de la misma clínica: la FK compuesta lo aceptaría.
      await expect(
        insert(a.tenantId, a.otherLocationId, p.id, otherLocationSession),
      ).rejects.toThrow(
        /pago de gasto del ajuste no es de esta clínica y sede/,
      );
      // Una salida de otra clínica no existe para A bajo RLS.
      const foreignExpense = await expense(b);
      const foreign = await raw.expensePayment.create({
        data: paymentData(b, foreignExpense.id),
      });
      await expect(
        insert(a.tenantId, a.locationId, foreign.id, closedSession),
      ).rejects.toThrow(
        /pago de gasto del ajuste no es de esta clínica y sede/,
      );
    });

    it('la salida del ajuste no cambia al unir el pendiente a una caja', async () => {
      const p = await outflow();
      const q = await outflow();
      const pending = await create(adjustment(p));
      await expect(
        asA((tx) =>
          tx.cashSessionAdjustment.update({
            where: { id: pending.id },
            data: { sessionId: openSession, expensePaymentId: q.id },
          }),
        ),
      ).rejects.toThrow(/inalterable/);
      // Unirlo a la caja abierta, sin tocar nada más, sigue valiendo.
      await expect(
        asA((tx) =>
          tx.cashSessionAdjustment.update({
            where: { id: pending.id },
            data: { sessionId: openSession },
          }),
        ),
      ).resolves.toMatchObject({ sessionId: openSession });
    });
  });
});
