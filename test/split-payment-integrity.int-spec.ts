import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient, TreatmentPlanStatus } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  gate,
  settle,
  transactionId,
  waitForTransactionWaiters,
} from './support/postgres-concurrency';
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
const HEAD_IS_LINE_1 = /apunta a su línea 1/;
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

    // Una sola sentencia con varias filas: el BEFORE ROW de la línea 2 corre
    // antes de que exista la 1, así que lo decide el trigger diferido (COMMIT).
    const insertRows = (
      tx: Prisma.TransactionClient,
      c: Clinic,
      splitId: string,
      rows: {
        id: string;
        line: number;
        patientId: string;
        planId: string;
        locationId: string;
      }[],
    ) =>
      tx.$executeRaw(Prisma.sql`
        INSERT INTO "payments" ("id","tenantId","locationId","treatmentPlanId","patientId","amount","currency","paidAt","updatedAt","splitId","splitLine")
        VALUES ${Prisma.join(
          rows.map(
            (r) =>
              Prisma.sql`(${r.id}::uuid, ${c.tenantId}::uuid, ${r.locationId}::uuid, ${r.planId}::uuid, ${r.patientId}::uuid, 10, 'USD', now(), now(), ${splitId}::uuid, ${r.line})`,
          ),
        )}`);

    it('una sola sentencia con la línea 2 (otro paciente) antes que la 1 falla al COMMIT', async () => {
      const splitId = randomUUID();
      await expect(
        asApp(a.tenantId, (tx) =>
          insertRows(tx, a, splitId, [
            {
              id: randomUUID(),
              line: 2,
              patientId: a.otherPatientId,
              planId: a.otherPlanId,
              locationId: a.locationId,
            },
            {
              id: splitId,
              line: 1,
              patientId: a.patientId,
              planId: a.planId,
              locationId: a.locationId,
            },
          ]),
        ),
      ).rejects.toThrow(SAME_PATIENT_LOCATION);
      expect(await raw.payment.count({ where: { splitId } })).toBe(0);
    });

    it('lo mismo con otra sede', async () => {
      const splitId = randomUUID();
      await expect(
        asApp(a.tenantId, (tx) =>
          insertRows(tx, a, splitId, [
            {
              id: randomUUID(),
              line: 2,
              patientId: a.patientId,
              planId: a.planId,
              locationId: a.otherLocationId,
            },
            {
              id: splitId,
              line: 1,
              patientId: a.patientId,
              planId: a.planId,
              locationId: a.locationId,
            },
          ]),
        ),
      ).rejects.toThrow(SAME_PATIENT_LOCATION);
    });

    it('control: la misma sentencia coherente, con la línea 2 primero, pasa', async () => {
      const splitId = randomUUID();
      const row = (line: number) => ({
        id: line === 1 ? splitId : randomUUID(),
        line,
        patientId: a.patientId,
        planId: a.planId,
        locationId: a.locationId,
      });
      await asApp(a.tenantId, (tx) =>
        insertRows(tx, a, splitId, [row(2), row(1)]),
      );
      expect(await raw.payment.count({ where: { splitId } })).toBe(2);
    });

    it('un cobro sin su línea 1 no se confirma', async () => {
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.payment.create({ data: lineData(a, randomUUID(), 2) }),
        ),
      ).rejects.toThrow();
    });

    it('una línea no puede apuntar a un abono suelto ni a otra línea como si fuera la 1', async () => {
      const loose = await raw.payment.create({
        data: lineData(a, randomUUID(), 1, { splitId: null, splitLine: null }),
      });
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.payment.create({ data: lineData(a, loose.id, 2) }),
        ),
      ).rejects.toThrow(HEAD_IS_LINE_1);
      const { ids } = await seedSplit(a, 2);
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.payment.create({ data: lineData(a, ids[1], 3) }),
        ),
      ).rejects.toThrow(HEAD_IS_LINE_1);
      expect(
        await raw.payment.count({
          where: { splitId: { in: [loose.id, ids[1]] } },
        }),
      ).toBe(0);
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

    it('anular el cobro y añadirle una línea a la vez: el alta espera a la anulación y falla', async () => {
      const { splitId, ids } = await seedSplit(a, 2);
      const started = gate<string>();
      const release = gate();
      const voider = settle(
        asApp(a.tenantId, async (tx) => {
          await voidLines(tx, a, ids);
          started.open(await transactionId(tx));
          await release.wait;
        }),
      );
      const xid = await started.wait;
      const inserter = settle(
        asApp(a.tenantId, (tx) =>
          tx.payment.create({ data: lineData(a, splitId, 3) }),
        ),
      );
      try {
        // El alta se queda esperando el bloqueo de la línea 1 (FOR SHARE).
        await waitForTransactionWaiters(raw, xid);
      } finally {
        release.open(undefined);
      }
      expect((await voider).status).toBe('fulfilled');
      const outcome = await inserter;
      expect(outcome.status).toBe('rejected');
      expect(String((outcome as { reason: unknown }).reason)).toMatch(
        VOID_TOGETHER,
      );
      expect(await raw.payment.count({ where: { splitId } })).toBe(2);
    });

    it('el alta de una línea bloquea la línea 1 FOR SHARE: espera a quien la tiene FOR NO KEY UPDATE', async () => {
      // Solo el bloqueo de la fila (lo que toma el UPDATE de la anulación),
      // sin tocar nada más: así la espera es la de la guarda y no la de otro
      // trigger (el libro del paciente).
      const { splitId } = await seedSplit(a, 2);
      const started = gate<string>();
      const release = gate();
      const holder = settle(
        asApp(a.tenantId, async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "payments" WHERE "id" = ${splitId}::uuid FOR NO KEY UPDATE`;
          started.open(await transactionId(tx));
          await release.wait;
        }),
      );
      const xid = await started.wait;
      const inserter = settle(
        asApp(a.tenantId, (tx) =>
          tx.payment.create({ data: lineData(a, splitId, 3) }),
        ),
      );
      try {
        await waitForTransactionWaiters(raw, xid);
      } finally {
        release.open(undefined);
      }
      expect((await holder).status).toBe('fulfilled');
      expect((await inserter).status).toBe('fulfilled');
      expect(await raw.payment.count({ where: { splitId } })).toBe(3);
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
    // El bloque DO de la migración, leído del fichero, para las clínicas de
    // este test y como dentalix_app (FORCE RLS, sin BYPASSRLS: el camino de un
    // owner sin superusuario). Las filas incoherentes se siembran como
    // superusuario, que salta los triggers.
    const migration = readFileSync(
      join(
        __dirname,
        '../prisma/migrations/20261121090000_dx426_split_payment_integrity/migration.sql',
      ),
      'utf8',
    );
    const report = migration.slice(migration.indexOf('DO $$'));
    const runReport = (...clinics: Clinic[]) => {
      const ids = clinics.map((c) => `'${c.tenantId}'`).join(',');
      const scoped = report.replace(
        'FROM public."tenants" ORDER BY',
        `FROM public."tenants" WHERE "id" IN (${ids}) ORDER BY`,
      );
      expect(scoped).not.toBe(report);
      return raw.$transaction([
        raw.$executeRawUnsafe('SET LOCAL ROLE dentalix_app'),
        raw.$executeRawUnsafe(scoped),
      ]);
    };
    const hint = (c: Clinic, text: string) =>
      new RegExp(`clínica ${c.tenantId}: ${text}`);

    it('pasa con los cobros divididos coherentes', async () => {
      await seedSplit(a, 3);
      await seedSplit(a, 2, true);
      await expect(runReport(a, b)).resolves.toBeDefined();
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
      await expect(runReport(a)).rejects.toThrow(
        hint(a, '1 líneas de otro paciente o sede'),
      );
      await raw.payment.delete({ where: { id: bad.id } });
    });

    it('falla si una línea apunta a un abono suelto como si fuera su línea 1', async () => {
      const loose = await raw.payment.create({
        data: lineData(a, randomUUID(), 1, { splitId: null, splitLine: null }),
      });
      const bad = await raw.payment.create({
        data: lineData(a, loose.id, 2),
      });
      await expect(runReport(a)).rejects.toThrow(
        hint(a, '0 líneas de otro paciente o sede, 1 líneas sin línea 1'),
      );
      await raw.payment.delete({ where: { id: bad.id } });
    });

    it('falla si una línea no tiene línea 1', async () => {
      const orphan = lineData(a, randomUUID(), 2);
      // Sin FK ni triggers (réplica restaurada): el único modo de tenerla.
      await raw.$transaction([
        raw.$executeRawUnsafe('SET LOCAL session_replication_role = replica'),
        raw.$executeRaw`INSERT INTO "payments" ("id","tenantId","locationId","treatmentPlanId","patientId","amount","currency","paidAt","updatedAt","splitId","splitLine")
          VALUES (${orphan.id}::uuid, ${a.tenantId}::uuid, ${a.locationId}::uuid, ${a.planId}::uuid, ${a.patientId}::uuid, 10, 'USD', now(), now(), ${orphan.splitId}::uuid, 2)`,
      ]);
      await expect(runReport(a)).rejects.toThrow(
        hint(a, '0 líneas de otro paciente o sede, 1 líneas sin línea 1'),
      );
      await raw.payment.delete({ where: { id: orphan.id } });
    });

    it('falla si un cobro está anulado a medias', async () => {
      const { ids } = await seedSplit(a, 2);
      const now = new Date();
      await raw.payment.update({
        where: { id: ids[1] },
        data: { deletedAt: now, voidedAt: now },
      });
      await expect(runReport(a)).rejects.toThrow(/1 cobros anulados a medias/);
      await raw.payment.update({
        where: { id: ids[1] },
        data: { deletedAt: null, voidedAt: null },
      });
    });

    it('falla si una línea > 1 lleva recibo', async () => {
      const { ids } = await seedSplit(b, 2);
      const location = await raw.location.findUniqueOrThrow({
        where: { id: b.locationId },
      });
      const prefix = location.receiptPrefix as string;
      await raw.paymentReceiptCounter.create({
        data: { tenantId: b.tenantId, seriesPrefix: prefix, lastNumber: 1 },
      });
      const receipt = await raw.paymentReceipt.create({
        data: {
          tenantId: b.tenantId,
          locationId: b.locationId,
          paymentId: ids[1],
          seriesPrefix: prefix,
          number: 1,
          snapshot: { version: 1 },
        },
      });
      await expect(runReport(b)).rejects.toThrow(
        hint(
          b,
          '0 líneas de otro paciente o sede, 0 líneas sin línea 1, 0 cobros anulados a medias, 1 recibos',
        ),
      );
      await raw.paymentReceipt.delete({ where: { id: receipt.id } });
    });
  });
});
