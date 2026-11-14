import { Prisma, PrismaClient, TreatmentPlanStatus } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';
import { PrismaPaymentReceiptRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment-receipt.repository';
import {
  locationData,
  type RegionalFixture,
} from './support/location-fixtures';

// DX-521: el recibo congela la región de su sede al emitir, y la foto de un
// recibo anterior (sin región) no se toca al leerla. Contra Postgres real.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const payments = new PrismaPaymentRepository(prisma, tenantContext);
const receipts = new PrismaPaymentReceiptRepository(prisma);

// Datos de test (no valores por defecto del producto).
const LONDON: RegionalFixture = {
  country: 'GB',
  currency: 'GBP',
  timeZone: 'Europe/London',
  locale: 'en-GB',
  hourCycle: 'h23',
  defaultPhoneRegion: 'GB',
};

const SUBDOMAIN = 'dx521-int';

let tenantId: string;
let userId: string;
let locationId: string;
let patientId: string;
let planId: string;

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: SUBDOMAIN },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  await raw.paymentReceipt.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.paymentReceiptCounter.deleteMany({
    where: { tenantId: { in: ids } },
  });
  await raw.paymentAllocation.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.paymentAllocationMovement.deleteMany({
    where: { tenantId: { in: ids } },
  });
  await raw.paymentPlanAmount.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.payment.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.treatmentPlan.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.patient.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.location.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  await raw.user.deleteMany({ where: { email: `${SUBDOMAIN}@example.com` } });
}

function pay() {
  return tenantContext.run(tenantId, locationId, () =>
    payments.create({
      treatmentPlanId: planId,
      patientId,
      amount: 65,
      currency: 'GBP',
      paidAt: new Date('2026-07-15T14:30:00.000Z'),
      method: 'CASH',
      createdById: userId,
      receiptPlanBalance: {
        currency: 'GBP',
        billable: 300,
        paid: 65,
        balance: 235,
      },
      planAmount: null,
      frozenRate: null,
    }),
  );
}

const read = (paymentId: string) =>
  tenantContext.run(tenantId, locationId, () =>
    receipts.findByPaymentId(paymentId),
  );

/** El jsonb de la foto tal cual está guardado, como texto. */
async function snapshotText(paymentId: string): Promise<string> {
  const [row] = await raw.$queryRaw<{ snapshot: string }[]>`
    SELECT "snapshot"::text AS snapshot FROM "payment_receipts"
     WHERE "paymentId" = ${paymentId}::uuid`;
  return row.snapshot;
}

/** Cambia los ajustes de la sede saltándose sus guardas (solo superusuario). */
async function updateLocation(sql: Prisma.Sql): Promise<void> {
  await raw.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw(sql);
  });
}

describe('DX-521 · el recibo congela la región de su sede (int)', () => {
  beforeAll(async () => {
    await cleanup();
    const tenant = await raw.tenant.create({
      data: { name: 'Clínica DX-521', subdomain: SUBDOMAIN },
    });
    tenantId = tenant.id;
    userId = (
      await raw.user.create({
        data: {
          email: `${SUBDOMAIN}@example.com`,
          passwordHash: 'x',
          fullName: 'Recepción Prueba',
        },
      })
    ).id;
    locationId = (
      await raw.location.create({
        data: locationData(LONDON, {
          tenantId,
          name: 'Sede Londres',
          address: 'Calle 1',
        }),
      })
    ).id;
    patientId = (
      await raw.patient.create({
        data: {
          tenantId,
          firstName: 'Carolina',
          lastName: 'Duque',
          docNumber: '1052345678',
        },
      })
    ).id;
    planId = (
      await raw.treatmentPlan.create({
        data: {
          tenantId,
          patientId,
          currency: 'GBP',
          status: TreatmentPlanStatus.ACCEPTED,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([raw.$disconnect(), prisma.$disconnect()]);
  });

  it('una emisión real guarda `regional` con la zona, el locale canónico y el reloj de la sede', async () => {
    const payment = await pay();
    const stored = JSON.parse(await snapshotText(payment.id)) as {
      version: number;
      regional?: unknown;
    };
    expect(stored.version).toBe(1);
    expect(stored.regional).toEqual({
      timeZone: 'Europe/London',
      locale: 'en-GB',
      hourCycle: 'h23',
    });
  });

  it('cambiar la zona de la sede después NO cambia la región del recibo emitido', async () => {
    const payment = await pay();
    const before = await snapshotText(payment.id);
    await updateLocation(
      Prisma.sql`UPDATE "locations" SET "timeZone" = 'America/Caracas', "locale" = 'es-VE'
                  WHERE "id" = ${locationId}::uuid`,
    );
    try {
      const source = await read(payment.id);
      if (source?.kind !== 'issued')
        throw new Error('se esperaba un recibo emitido');
      expect(source.receipt.snapshot.regional).toEqual({
        timeZone: 'Europe/London',
        locale: 'en-GB',
        hourCycle: 'h23',
      });
      // Los ajustes de hoy están aparte, y solo valen sin región en la foto.
      expect(source.locationRegional).toEqual({
        timeZone: 'America/Caracas',
        locale: 'es-VE',
        hourCycle: 'h23',
      });
      expect(await snapshotText(payment.id)).toBe(before);
    } finally {
      await updateLocation(
        Prisma.sql`UPDATE "locations" SET "timeZone" = 'Europe/London', "locale" = 'en-GB'
                    WHERE "id" = ${locationId}::uuid`,
      );
    }
  });

  it('un recibo anterior (foto sin `regional`) sigue idéntico byte a byte tras leerlo y se lee con la sede de hoy', async () => {
    const payment = await pay();
    // La foto de antes de DX-521: sin la clave. Solo el superusuario, saltando
    // el trigger de inmutabilidad (no hay migración de datos).
    await updateLocation(
      Prisma.sql`UPDATE "payment_receipts" SET "snapshot" = "snapshot" - 'regional'
                  WHERE "paymentId" = ${payment.id}::uuid`,
    );
    const before = await snapshotText(payment.id);
    expect(before).not.toContain('"regional"');

    const source = await read(payment.id);
    if (source?.kind !== 'issued')
      throw new Error('se esperaba un recibo emitido');
    expect(source.receipt.snapshot.regional).toBeUndefined();
    expect(source.locationRegional).toEqual({
      timeZone: 'Europe/London',
      locale: 'en-GB',
      hourCycle: 'h23',
    });
    // Leer no reescribe nada.
    expect(await snapshotText(payment.id)).toBe(before);
  });

  it('una sede sin ajustes válidos no rompe la lectura: región de hoy `null`', async () => {
    const payment = await pay();
    await updateLocation(
      Prisma.sql`UPDATE "locations" SET "hourCycle" = NULL WHERE "id" = ${locationId}::uuid`,
    );
    try {
      const source = await read(payment.id);
      expect(source).not.toBeNull();
      expect(source?.locationRegional).toBeNull();
    } finally {
      await updateLocation(
        Prisma.sql`UPDATE "locations" SET "hourCycle" = 'h23' WHERE "id" = ${locationId}::uuid`,
      );
    }
  });
});
