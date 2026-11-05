import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient, TreatmentPlanStatus } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-426 (DB-063): las líneas de un cobro dividido (DX-390) son del mismo
// paciente y de la misma sede, el recibo es el de la línea 1, y se anulan
// todas o ninguna, y eso lo exige la BD, no solo la app. Todo se escribe como
// dentalix_app (RLS FORCE, sin superusuario: el trigger no se salta); `raw`
// (DIRECT_URL, superusuario) solo siembra, lee y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAINS = ['dx426-int-a', 'dx426-int-b'];
const EMAILS = SUBDOMAINS.map((s) => `${s}@example.com`);

const SAME_PATIENT_LOCATION = /mismo paciente y de la misma sede/;
const NOT_MOVABLE = /no cambia de paciente, sede ni cobro/;
const VOID_TOGETHER = /se anula completo/;
const RECEIPT_HEAD = /recibo de un cobro dividido es el de su línea 1/;

interface Clinic {
  tenantId: string;
  userId: string;
  locationId: string;
  otherLocationId: string;
  patientId: string;
  planId: string;
  otherPatientId: string;
  otherPlanId: string;
}

let a: Clinic;
let b: Clinic;

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
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede principal',
      address: 'Av. Francisco de Miranda',
    }),
  });
  const otherLocation = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Valencia',
      address: 'Av. Bolívar Norte',
    }),
  });
  const mkPatient = async (firstName: string, doc: string) => {
    const patient = await raw.patient.create({
      data: {
        tenantId: tenant.id,
        firstName,
        lastName: 'Rondón',
        docNumber: doc,
      },
    });
    const plan = await raw.treatmentPlan.create({
      data: {
        tenantId: tenant.id,
        patientId: patient.id,
        currency: 'USD',
        status: TreatmentPlanStatus.ACCEPTED,
      },
    });
    return { patientId: patient.id, planId: plan.id };
  };
  const p1 = await mkPatient('Carolina', `V1${subdomain.length}0345678`);
  const p2 = await mkPatient('Andrés', `V2${subdomain.length}0345678`);
  return {
    tenantId: tenant.id,
    userId: user.id,
    locationId: location.id,
    otherLocationId: otherLocation.id,
    patientId: p1.patientId,
    planId: p1.planId,
    otherPatientId: p2.patientId,
    otherPlanId: p2.planId,
  };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const tenantId = { in: tenants.map((t) => t.id) };
  await raw.paymentReceipt.deleteMany({ where: { tenantId } });
  await raw.paymentReceiptCounter.deleteMany({ where: { tenantId } });
  await raw.paymentAllocation.deleteMany({ where: { tenantId } });
  await raw.paymentAllocationMovement.deleteMany({ where: { tenantId } });
  await raw.paymentPlanAmount.deleteMany({ where: { tenantId } });
  // Las líneas apuntan a su línea 1 (FK RESTRICT): primero las demás.
  await raw.payment.deleteMany({ where: { tenantId, splitLine: { gt: 1 } } });
  await raw.payment.deleteMany({ where: { tenantId } });
  await raw.treatmentPlan.deleteMany({ where: { tenantId } });
  await raw.patient.deleteMany({ where: { tenantId } });
  await raw.location.deleteMany({ where: { tenantId } });
  await raw.tenant.deleteMany({ where: { id: tenantId } });
  await raw.user.deleteMany({ where: { email: { in: EMAILS } } });
}

function asApp<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.runWithTenant(tenantId, fn);
}

function lineData(
  c: Clinic,
  splitId: string,
  splitLine: number,
  overrides: Partial<Prisma.PaymentUncheckedCreateInput> = {},
): Prisma.PaymentUncheckedCreateInput {
  return {
    id: splitLine === 1 ? splitId : randomUUID(),
    tenantId: c.tenantId,
    locationId: c.locationId,
    treatmentPlanId: c.planId,
    patientId: c.patientId,
    amount: 10,
    currency: 'USD',
    paidAt: new Date(),
    createdById: c.userId,
    splitId,
    splitLine,
    ...overrides,
  };
}

/** Un cobro dividido de `n` líneas coherentes (siembra: superusuario). */
async function seedSplit(
  c: Clinic,
  n = 2,
  voided = false,
): Promise<{ splitId: string; ids: string[] }> {
  const splitId = randomUUID();
  const ids: string[] = [];
  const now = new Date();
  for (let line = 1; line <= n; line++) {
    const row = await raw.payment.create({
      data: lineData(
        c,
        splitId,
        line,
        voided
          ? {
              deletedAt: now,
              voidedAt: now,
              voidedById: c.userId,
              voidReason: 'Cobro duplicado por error',
            }
          : {},
      ),
    });
    ids.push(row.id);
  }
  return { splitId, ids };
}

/** Anula como la API (`voidLine`): un UPDATE por línea, rol de la app. */
function voidLines(
  tx: Prisma.TransactionClient,
  c: Clinic,
  ids: string[],
): Promise<unknown[]> {
  const now = new Date();
  return Promise.all(
    ids.map((id) =>
      tx.payment.updateMany({
        where: { id, deletedAt: null },
        data: {
          deletedAt: now,
          voidedAt: now,
          voidedById: c.userId,
          voidReason: 'Cobro duplicado por error',
        },
      }),
    ),
  );
}

const voidedAt = async (id: string) =>
  (await raw.payment.findUniqueOrThrow({ where: { id } })).voidedAt;

describe('cobro dividido: integridad en la BD (int, DX-426)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  describe('mismo paciente y sede', () => {
    it('control: líneas coherentes se registran', async () => {
      const splitId = randomUUID();
      await asApp(a.tenantId, async (tx) => {
        await tx.payment.create({ data: lineData(a, splitId, 1) });
        await tx.payment.create({ data: lineData(a, splitId, 2) });
      });
      expect(await raw.payment.count({ where: { splitId } })).toBe(2);
    });

    it('una línea de otro paciente en un cobro existente falla', async () => {
      const { splitId } = await seedSplit(a);
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.payment.create({
            data: lineData(a, splitId, 3, {
              patientId: a.otherPatientId,
              treatmentPlanId: a.otherPlanId,
            }),
          }),
        ),
      ).rejects.toThrow(SAME_PATIENT_LOCATION);
      expect(await raw.payment.count({ where: { splitId } })).toBe(2);
    });

    it('una línea de otra sede en un cobro existente falla', async () => {
      const { splitId } = await seedSplit(a);
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.payment.create({
            data: lineData(a, splitId, 3, { locationId: a.otherLocationId }),
          }),
        ),
      ).rejects.toThrow(SAME_PATIENT_LOCATION);
      expect(await raw.payment.count({ where: { splitId } })).toBe(2);
    });

    it('una línea de otra clínica en un cobro existente falla (FK compuesta)', async () => {
      const { splitId } = await seedSplit(a);
      await expect(
        asApp(b.tenantId, (tx) =>
          tx.payment.create({ data: lineData(b, splitId, 3) }),
        ),
      ).rejects.toThrow();
      expect(await raw.payment.count({ where: { splitId } })).toBe(2);
    });

    it('una línea suelta nunca es la 1 de otro: el abono sin cobro dividido no se ve afectado', async () => {
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.payment.create({
            data: lineData(a, randomUUID(), 1, {
              splitId: null,
              splitLine: null,
              locationId: a.otherLocationId,
            }),
          }),
        ),
      ).resolves.toBeDefined();
    });

    it('no se mueve la sede de ninguna línea (ni de la 1) ni se cambia de cobro', async () => {
      const { splitId, ids } = await seedSplit(a, 3);
      for (const id of [ids[0], ids[2]]) {
        await expect(
          asApp(a.tenantId, (tx) =>
            tx.payment.update({
              where: { id },
              data: { locationId: a.otherLocationId },
            }),
          ),
        ).rejects.toThrow(NOT_MOVABLE);
      }
      const other = await seedSplit(a, 2);
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.payment.update({
            where: { id: ids[2] },
            data: { splitId: other.splitId, splitLine: 3 },
          }),
        ),
      ).rejects.toThrow();
      const row = await raw.payment.findUniqueOrThrow({
        where: { id: ids[2] },
      });
      expect(row.splitId).toBe(splitId);
      expect(row.locationId).toBe(a.locationId);
    });

    it('un abono suelto no se puede meter en un cobro dividido después', async () => {
      const { splitId } = await seedSplit(a);
      const loose = await raw.payment.create({
        data: lineData(a, splitId, 3, { splitId: null, splitLine: null }),
      });
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.payment.update({
            where: { id: loose.id },
            data: { splitId, splitLine: 3 },
          }),
        ),
      ).rejects.toThrow(NOT_MOVABLE);
    });
  });

  describe('recibo', () => {
    it('solo la línea 1 de un cobro dividido lleva recibo', async () => {
      const { ids } = await seedSplit(a);
      const location = await raw.location.findUniqueOrThrow({
        where: { id: a.locationId },
      });
      const prefix = location.receiptPrefix as string;
      await raw.paymentReceiptCounter.create({
        data: {
          tenantId: a.tenantId,
          seriesPrefix: prefix,
          lastNumber: 1,
        },
      });
      const insert = (paymentId: string) =>
        asApp(a.tenantId, (tx) =>
          tx.paymentReceipt.create({
            data: {
              tenantId: a.tenantId,
              locationId: a.locationId,
              paymentId,
              seriesPrefix: prefix,
              number: 1,
              snapshot: { version: 1 },
            },
          }),
        );
      await expect(insert(ids[1])).rejects.toThrow(RECEIPT_HEAD);
      await expect(insert(ids[0])).resolves.toBeDefined();
    });
  });

  describe('anular todas o ninguna', () => {
    it('anular el cobro anula todas las líneas en la misma transacción', async () => {
      const { ids } = await seedSplit(a, 3);
      await asApp(a.tenantId, (tx) => voidLines(tx, a, ids));
      for (const id of ids) expect(await voidedAt(id)).not.toBeNull();
    });

    it.each([
      ['la línea 2', 1],
      ['la línea 1', 0],
    ])('anular solo %s falla y no queda nada anulado', async (_n, index) => {
      const { ids } = await seedSplit(a, 3);
      await expect(
        asApp(a.tenantId, (tx) => voidLines(tx, a, [ids[index]])),
      ).rejects.toThrow(VOID_TOGETHER);
      for (const id of ids) expect(await voidedAt(id)).toBeNull();
    });

    it('anular unas líneas sí y otras no, en la misma transacción, falla', async () => {
      const { ids } = await seedSplit(a, 3);
      await expect(
        asApp(a.tenantId, (tx) => voidLines(tx, a, ids.slice(0, 2))),
      ).rejects.toThrow(VOID_TOGETHER);
      for (const id of ids) expect(await voidedAt(id)).toBeNull();
    });

    it('anular las líneas en transacciones distintas falla en la primera', async () => {
      const { ids } = await seedSplit(a, 2);
      await expect(
        asApp(a.tenantId, (tx) => voidLines(tx, a, [ids[0]])),
      ).rejects.toThrow(VOID_TOGETHER);
      await expect(voidedAt(ids[1])).resolves.toBeNull();
    });

    it('no se añade una línea viva a un cobro ya anulado', async () => {
      const { splitId, ids } = await seedSplit(a, 2, true);
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.payment.create({ data: lineData(a, splitId, 3) }),
        ),
      ).rejects.toThrow(VOID_TOGETHER);
      expect(await raw.payment.count({ where: { splitId } })).toBe(ids.length);
    });

    it('un abono suelto se sigue anulando solo (SEC-042 intacto)', async () => {
      const loose = await raw.payment.create({
        data: lineData(a, randomUUID(), 1, { splitId: null, splitLine: null }),
      });
      await asApp(a.tenantId, (tx) => voidLines(tx, a, [loose.id]));
      expect(await voidedAt(loose.id)).not.toBeNull();
    });

    it('un cobro anulado sigue siendo definitivo (SEC-042 convive)', async () => {
      const { ids } = await seedSplit(a, 2, true);
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.payment.update({ where: { id: ids[0] }, data: { notes: 'x' } }),
        ),
      ).rejects.toThrow(/abono anulado/);
    });
  });

  describe('informe previo de la migración', () => {
    // El bloque DO de la migración (lee clínica a clínica con app.current_tenant;
    // aquí lo ejecuta el superusuario, que salta los triggers al sembrar).
    const migration = readFileSync(
      join(
        __dirname,
        '../prisma/migrations/20261121090000_dx426_split_payment_integrity/migration.sql',
      ),
      'utf8',
    );
    const report = migration.slice(migration.indexOf('DO $$'));

    it('pasa con los cobros divididos coherentes', async () => {
      await seedSplit(a, 3);
      await seedSplit(a, 2, true);
      await expect(raw.$executeRawUnsafe(report)).resolves.toBeDefined();
    });

    it.each([
      [
        'otra sede',
        (c: Clinic): Partial<Prisma.PaymentUncheckedCreateInput> => ({
          locationId: c.otherLocationId,
        }),
      ],
      [
        'otro paciente',
        (c: Clinic): Partial<Prisma.PaymentUncheckedCreateInput> => ({
          patientId: c.otherPatientId,
          treatmentPlanId: c.otherPlanId,
        }),
      ],
    ])('falla con el recuento si una línea es de %s', async (_name, change) => {
      const { splitId } = await seedSplit(a, 2);
      const bad = await raw.payment.create({
        data: lineData(a, splitId, 3, change(a)),
      });
      await expect(raw.$executeRawUnsafe(report)).rejects.toThrow(
        new RegExp(`clínica ${a.tenantId}: 1 líneas de otro paciente o sede`),
      );
      await raw.payment.delete({ where: { id: bad.id } });
    });

    it('falla si un cobro está anulado a medias', async () => {
      const { ids } = await seedSplit(a, 2);
      const now = new Date();
      await raw.payment.update({
        where: { id: ids[1] },
        data: { deletedAt: now, voidedAt: now },
      });
      await expect(raw.$executeRawUnsafe(report)).rejects.toThrow(
        /1 cobros anulados a medias/,
      );
      await raw.payment.update({
        where: { id: ids[1] },
        data: { deletedAt: null, voidedAt: null },
      });
    });
  });
});
