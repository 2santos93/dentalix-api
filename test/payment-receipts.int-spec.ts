import { Prisma, PrismaClient, TreatmentPlanStatus } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';
import type { CreatePaymentRepoInput } from '../src/modules/payments/domain/ports/payment-repository.port';

// DX-136: recibo de caja numerado por sede, contra Postgres real. Los
// abonos se registran con el repositorio de la API (rol dentalix_app, RLS);
// `raw` (DIRECT_URL, superusuario) solo siembra, lee sin RLS y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const payments = new PrismaPaymentRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx136-int-a', 'dx136-int-b'];

interface Clinic {
  tenantId: string;
  userId: string;
  locationId: string;
  patientId: string;
  planId: string;
}

let a: Clinic;
let b: Clinic;
let northId: string;

class Rollback extends Error {}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: `Clínica ${subdomain}`, subdomain },
  });
  const user = await raw.user.create({
    data: {
      email: `${subdomain}@example.com`,
      passwordHash: 'x',
      fullName: 'Recepción Prueba',
    },
  });
  const location = await raw.location.create({
    data: { tenantId: tenant.id, name: 'Sede principal', address: 'Calle 1' },
  });
  const patient = await raw.patient.create({
    data: {
      tenantId: tenant.id,
      firstName: 'Carolina',
      lastName: 'Duque',
      docNumber: `10${subdomain.length}2345678`,
    },
  });
  const plan = await raw.treatmentPlan.create({
    data: {
      tenantId: tenant.id,
      patientId: patient.id,
      currency: 'COP',
      status: TreatmentPlanStatus.ACCEPTED,
    },
  });
  return {
    tenantId: tenant.id,
    userId: user.id,
    locationId: location.id,
    patientId: patient.id,
    planId: plan.id,
  };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  // Como superusuario: el trigger deja borrar (limpieza de la base de test).
  await raw.paymentReceipt.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.paymentReceiptCounter.deleteMany({
    where: { tenantId: { in: ids } },
  });
  await raw.payment.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.treatmentPlan.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.patient.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.location.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  await raw.user.deleteMany({
    where: { email: { in: SUBDOMAINS.map((s) => `${s}@example.com`) } },
  });
}

function pay(
  clinic: Clinic,
  overrides: Partial<CreatePaymentRepoInput> = {},
  locationId = clinic.locationId,
) {
  return tenantContext.run(clinic.tenantId, locationId, () =>
    payments.create({
      treatmentPlanId: clinic.planId,
      patientId: clinic.patientId,
      amount: 100000,
      currency: 'COP',
      paidAt: new Date('2026-10-17T15:00:00.000Z'),
      method: 'CASH',
      createdById: clinic.userId,
      receiptPlanBalance: {
        currency: 'COP',
        billable: 900000,
        paid: 100000,
        balance: 800000,
      },
      ...overrides,
    }),
  );
}

/** Corre `fn` como dentalix_app con la clínica fijada (como la API). */
function asApp<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return appRole.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

async function numbersOf(tenantId: string, series: string): Promise<number[]> {
  const rows = await raw.paymentReceipt.findMany({
    where: { tenantId, seriesPrefix: series },
    select: { number: true },
    orderBy: { number: 'asc' },
  });
  return rows.map((r) => r.number);
}

describe('DX-136 · recibo de caja numerado por sede (int)', () => {
  beforeAll(async () => {
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
    northId = (
      await raw.location.create({
        data: { tenantId: a.tenantId, name: 'Sede Norte' },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([
      raw.$disconnect(),
      appRole.$disconnect(),
      prisma.$disconnect(),
    ]);
  });

  describe('serie de la sede', () => {
    it('se deriva del nombre (sin tildes ni palabras genéricas) y se desambigua dentro de la clínica', async () => {
      const second = await asApp(a.tenantId, (tx) =>
        tx.location.create({
          data: { tenantId: a.tenantId, name: 'Sede Nórte' },
          select: { receiptPrefix: true },
        }),
      );
      const prefixes = await raw.location.findMany({
        where: { tenantId: a.tenantId },
        select: { name: true, receiptPrefix: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(prefixes.map((p) => p.receiptPrefix)).toEqual([
        'PRI',
        'NOR',
        'NOR2',
      ]);
      expect(second.receiptPrefix).toBe('NOR2');
    });

    it('otra clínica puede usar la misma serie', async () => {
      const location = await raw.location.findUniqueOrThrow({
        where: { id: b.locationId },
        select: { receiptPrefix: true },
      });
      expect(location.receiptPrefix).toBe('PRI');
    });

    it('una serie con otro formato la rechaza la BD', async () => {
      await expect(
        raw.location.update({
          where: { id: northId },
          data: { receiptPrefix: 'nor-1' },
        }),
      ).rejects.toThrow(/locations_receipt_prefix_check/);
    });
  });

  describe('contador', () => {
    it('20 abonos concurrentes en la misma sede: números 1..20, sin duplicados ni huecos', async () => {
      const created = await Promise.all(
        Array.from({ length: 20 }, () => pay(a)),
      );
      expect(await numbersOf(a.tenantId, 'PRI')).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
      expect(new Set(created.map((p) => p.receiptNumber)).size).toBe(20);
      expect(created.map((p) => p.receiptNumber).sort()).toContain(
        'PRI-000020',
      );
      const counter = await raw.paymentReceiptCounter.findUniqueOrThrow({
        where: {
          tenantId_seriesPrefix: { tenantId: a.tenantId, seriesPrefix: 'PRI' },
        },
      });
      expect(counter.lastNumber).toBe(20);
    }, 30_000);

    it('cada sede lleva su propia serie', async () => {
      const north = await pay(a, {}, northId);
      expect(north.receiptNumber).toBe('NOR-000001');
      const other = await pay(b);
      expect(other.receiptNumber).toBe('PRI-000001');
    });

    it('un rollback deshace el incremento: el siguiente número no deja hueco', async () => {
      await expect(
        asApp(a.tenantId, async (tx) => {
          await tx.$executeRaw`
            UPDATE "payment_receipt_counters" SET "lastNumber" = "lastNumber" + 1
             WHERE "tenantId" = ${a.tenantId}::uuid AND "seriesPrefix" = 'PRI'`;
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      const next = await pay(a);
      expect(next.receiptNumber).toBe('PRI-000021');
      expect(await numbersOf(a.tenantId, 'PRI')).toHaveLength(21);
    });

    it('dos reintentos simultáneos con la misma Idempotency-Key: un abono, un recibo, sin hueco', async () => {
      const key = '0b5f3c1e-2d4a-4f6b-8c9d-0e1f2a3b4c5d';
      const [first, second] = await Promise.all([
        pay(a, { idempotencyKey: key }),
        pay(a, { idempotencyKey: key }),
      ]);
      expect(second.id).toBe(first.id);
      expect(first.receiptNumber).toBe('PRI-000022');
      const next = await pay(a);
      expect(next.receiptNumber).toBe('PRI-000023');
      expect(await numbersOf(a.tenantId, 'PRI')).toEqual(
        Array.from({ length: 23 }, (_, i) => i + 1),
      );
    });

    it('el contador solo avanza de uno en uno y no se borra', async () => {
      await expect(
        asApp(
          a.tenantId,
          (tx) =>
            tx.$executeRaw`
            UPDATE "payment_receipt_counters" SET "lastNumber" = "lastNumber" + 5
             WHERE "tenantId" = ${a.tenantId}::uuid AND "seriesPrefix" = 'PRI'`,
        ),
      ).rejects.toThrow(/solo avanza de uno en uno/);
      await expect(
        asApp(
          a.tenantId,
          (tx) =>
            tx.$executeRaw`
            DELETE FROM "payment_receipt_counters"
             WHERE "tenantId" = ${a.tenantId}::uuid`,
        ),
      ).rejects.toThrow(/nunca se reutiliza/);
    });
  });

  describe('unicidad y coherencia', () => {
    it('no se puede insertar un número repetido ni uno que no venga del contador', async () => {
      const payment = await raw.payment.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          treatmentPlanId: a.planId,
          patientId: a.patientId,
          amount: 1,
          currency: 'COP',
          paidAt: new Date(),
        },
      });
      const insert = (number: number) =>
        asApp(a.tenantId, (tx) =>
          tx.paymentReceipt.create({
            data: {
              tenantId: a.tenantId,
              locationId: a.locationId,
              paymentId: payment.id,
              seriesPrefix: 'PRI',
              number,
              snapshot: { version: 1 },
            },
          }),
        );
      // El 5 ya existe (y además no es el último del contador).
      await expect(insert(5)).rejects.toThrow();
      // El 24 no lo ha dado el contador.
      await expect(insert(24)).rejects.toThrow(
        /no es el que acaba de dar el contador/,
      );
      // El 23 es el del contador, pero ya es de otro recibo.
      await expect(insert(23)).rejects.toThrow(
        /payment_receipts_tenant_series_number_key|Unique constraint/,
      );
      await raw.payment.delete({ where: { id: payment.id } });
    });

    it('el recibo tiene que ser de un abono de la misma clínica y de la misma sede', async () => {
      const [receiptB] = await raw.paymentReceipt.findMany({
        where: { tenantId: b.tenantId },
        take: 1,
      });
      const insertFor = (paymentId: string, locationId: string) =>
        asApp(a.tenantId, (tx) =>
          tx.paymentReceipt.create({
            data: {
              tenantId: a.tenantId,
              locationId,
              paymentId,
              seriesPrefix: 'PRI',
              number: 23,
              snapshot: { version: 1 },
            },
          }),
        );
      // Abono de otra clínica (la RLS no lo deja ver).
      await expect(insertFor(receiptB.paymentId, a.locationId)).rejects.toThrow(
        /misma clínica y sede/,
      );
      // Abono de la clínica, pero de otra sede.
      const north = await raw.payment.create({
        data: {
          tenantId: a.tenantId,
          locationId: northId,
          treatmentPlanId: a.planId,
          patientId: a.patientId,
          amount: 1,
          currency: 'COP',
          paidAt: new Date(),
        },
      });
      await expect(insertFor(north.id, a.locationId)).rejects.toThrow(
        /misma clínica y sede/,
      );
      await raw.payment.delete({ where: { id: north.id } });
    });

    it('un abono tiene como mucho un recibo', async () => {
      const [receipt] = await raw.paymentReceipt.findMany({
        where: { tenantId: a.tenantId },
        take: 1,
      });
      await expect(
        asApp(a.tenantId, async (tx) => {
          await tx.$executeRaw`
            INSERT INTO "payment_receipt_counters" ("tenantId", "seriesPrefix", "lastNumber")
            VALUES (${a.tenantId}::uuid, 'PRI', 1)
            ON CONFLICT ("tenantId", "seriesPrefix")
            DO UPDATE SET "lastNumber" = "payment_receipt_counters"."lastNumber" + 1`;
          const [{ lastNumber }] = await tx.$queryRaw<{ lastNumber: number }[]>`
            SELECT "lastNumber" FROM "payment_receipt_counters"
             WHERE "tenantId" = ${a.tenantId}::uuid AND "seriesPrefix" = 'PRI'`;
          return tx.paymentReceipt.create({
            data: {
              tenantId: a.tenantId,
              locationId: a.locationId,
              paymentId: receipt.paymentId,
              seriesPrefix: 'PRI',
              number: lastNumber,
              snapshot: { version: 1 },
            },
          });
        }),
      ).rejects.toThrow(/paymentId|Unique constraint/);
    });
  });

  describe('RLS entre clínicas', () => {
    it('la clínica B no ve los recibos ni los contadores de A', async () => {
      const seen = await asApp(b.tenantId, async (tx) => ({
        receipts: await tx.paymentReceipt.findMany({
          where: { tenantId: a.tenantId },
        }),
        counters: await tx.paymentReceiptCounter.findMany({
          where: { tenantId: a.tenantId },
        }),
      }));
      expect(seen).toEqual({ receipts: [], counters: [] });
    });

    it('la clínica B no puede escribir un contador de A', async () => {
      await expect(
        asApp(
          b.tenantId,
          (tx) =>
            tx.$executeRaw`
            INSERT INTO "payment_receipt_counters" ("tenantId", "seriesPrefix", "lastNumber")
            VALUES (${a.tenantId}::uuid, 'ZZZ', 1)`,
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('inmutabilidad', () => {
    let receiptId: string;

    beforeAll(async () => {
      const payment = await pay(a);
      receiptId = (
        await raw.paymentReceipt.findUniqueOrThrow({
          where: { paymentId: payment.id },
          select: { id: true },
        })
      ).id;
    });

    it('la foto guarda los datos al emitir, con el documento enmascarado', async () => {
      const receipt = await raw.paymentReceipt.findUniqueOrThrow({
        where: { id: receiptId },
      });
      expect(receipt.snapshot).toMatchObject({
        version: 1,
        fiscalDataPending: true,
        clinic: { name: 'Clínica dx136-int-a', taxId: null },
        location: { name: 'Sede principal', address: 'Calle 1' },
        patient: { fullName: 'Carolina Duque', docNumberMasked: '*******5678' },
        planBalance: { currency: 'COP', balance: 800000 },
        cashier: { fullName: 'Recepción Prueba' },
        legalNotice: 'Este documento no es factura',
      });
      expect(JSON.stringify(receipt.snapshot)).not.toContain('112345678');
    });

    it('el UPDATE de la foto lo rechaza el trigger', async () => {
      await expect(
        asApp(
          a.tenantId,
          (tx) =>
            tx.$executeRaw`
            UPDATE "payment_receipts" SET "snapshot" = '{"version":1}'::jsonb
             WHERE "id" = ${receiptId}::uuid`,
        ),
      ).rejects.toThrow(/inalterable/);
      await expect(
        asApp(
          a.tenantId,
          (tx) =>
            tx.$executeRaw`
            UPDATE "payment_receipts" SET "number" = 999
             WHERE "id" = ${receiptId}::uuid`,
        ),
      ).rejects.toThrow(/inalterable/);
    });

    it('el DELETE lo rechaza el trigger', async () => {
      await expect(
        asApp(
          a.tenantId,
          (tx) =>
            tx.$executeRaw`DELETE FROM "payment_receipts" WHERE "id" = ${receiptId}::uuid`,
        ),
      ).rejects.toThrow(/no admite DELETE/);
    });

    it('anular el abono marca el recibo ANULADO una sola vez y conserva su número', async () => {
      const receipt = await raw.paymentReceipt.findUniqueOrThrow({
        where: { id: receiptId },
      });
      const voidedAt = new Date('2026-10-17T18:00:00.000Z');
      const voided = await tenantContext.run(a.tenantId, undefined, () =>
        payments.softDelete(receipt.paymentId, {
          voidedAt,
          voidedById: a.userId,
          reason: 'Cobro duplicado',
        }),
      );
      expect(voided).toBe(true);
      const after = await raw.paymentReceipt.findUniqueOrThrow({
        where: { id: receiptId },
      });
      expect(after).toMatchObject({
        number: receipt.number,
        seriesPrefix: receipt.seriesPrefix,
        voidedAt,
        voidedById: a.userId,
        voidReason: 'Cobro duplicado',
      });
      expect(after.snapshot).toEqual(receipt.snapshot);
      await expect(
        asApp(
          a.tenantId,
          (tx) =>
            tx.$executeRaw`
            UPDATE "payment_receipts" SET "voidedAt" = now(), "voidReason" = 'otra vez'
             WHERE "id" = ${receiptId}::uuid`,
        ),
      ).rejects.toThrow(/ya está anulado/);
    });
  });
});
