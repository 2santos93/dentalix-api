import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-051, capa DB: bases de los abonos, imputaciones, cola de repartos e
// historial. RLS FORCE en las cuatro tablas, FK compuestas (el ítem es del
// plan del abono; sin base no se imputa; un abono a un saldo migrado no tiene
// base), CHECK de importes, la base solo cambia «manual», una imputación solo
// cambia de importe, la red de R7 (`payment_allocations_guard`), la liberación
// al bajar el facturable (AUTO antes que MANUAL, de la más reciente a la más
// antigua) por cada camino que lo baja, el encolado (INSERT simple, con la
// guarda IS DISTINCT FROM) y el historial con su causa. Lo que se prueba va
// como dentalix_app con `app.current_tenant` fijado (como la app); `raw`
// (DIRECT_URL, superusuario) siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const SUBDOMAINS = ['dx051-int-a', 'dx051-int-b'];
const EMAIL = 'dx051-int@example.com';
const FK_VIOLATION = { code: 'P2003' };
const ITEM_EXCEEDED = /La imputación supera el saldo del ítem \(DX-051\)/;
const BASE_EXCEEDED = /La imputación supera el importe del abono \(DX-051\)/;
const VOIDED = /El abono está anulado \(DX-051\)/;
const CURRENCY_CHANGED = /La moneda del plan cambió \(DX-051\)/;
const AMOUNT_CHECK = /amount_check/;
const DENIED = /permission denied/;
const DAY = new Date('2026-10-20T00:00:00.000Z');
const TABLES = [
  'payment_plan_amounts',
  'payment_allocations',
  'plan_allocation_rebalance_requests',
  'payment_allocation_movements',
] as const;

interface Clinic {
  tenantId: string;
  locationId: string;
  patientId: string;
  catalogItemId: string;
}

/** Plan EUR con un ítem DONE de 100 y uno ACCEPTED de 50, y un abono de 120 con base. */
interface Fixture {
  planId: string;
  done: string;
  accepted: string;
  paymentId: string;
}

let userId: string;
let a: Clinic;
let b: Clinic;
let seq = 0;

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const location = await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, { tenantId, name: 'Sede' }),
  });
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: 'Imputada' },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId,
      code: `dx051-${subdomain}`,
      kind: 'PROCEDURE',
      labelEs: 'Resina',
      color: '#123456',
    },
  });
  return {
    tenantId,
    locationId: location.id,
    patientId: patient.id,
    catalogItemId: catalog.id,
  };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const where = { tenantId: { in: ids } };
  // Superusuario: los triggers de solo-inserción dejan la purga administrativa.
  // Las imputaciones antes que el historial: borrarlas deja su movimiento.
  await raw.paymentAllocation.deleteMany({ where });
  await raw.paymentAllocationMovement.deleteMany({ where });
  await raw.paymentPlanAmount.deleteMany({ where });
  await raw.cancellationFee.deleteMany({ where });
  await raw.appointment.deleteMany({ where });
  await raw.cancellationPolicyVersion.deleteMany({ where });
  await raw.payment.deleteMany({ where });
  await raw.openingBalance.deleteMany({ where });
  await raw.patientImportBatch.deleteMany({ where });
  await raw.treatmentPlanItem.deleteMany({ where });
  // La cola cae con sus planes (ON DELETE CASCADE).
  await raw.treatmentPlan.deleteMany({ where });
  await raw.patientLedger.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.dentalCatalogItem.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
}

/** SQL como dentalix_app con `app.current_tenant` fijado (como la app). */
function asApp<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return appRole.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

async function plan(
  clinic: Clinic,
  data: Partial<Prisma.TreatmentPlanUncheckedCreateInput> = {},
): Promise<string> {
  return (
    await raw.treatmentPlan.create({
      data: {
        tenantId: clinic.tenantId,
        patientId: clinic.patientId,
        currency: 'EUR',
        status: 'ACCEPTED',
        ...data,
      },
    })
  ).id;
}

async function item(
  clinic: Clinic,
  planId: string,
  price: number,
  status: 'PROPOSED' | 'ACCEPTED' | 'DONE',
): Promise<string> {
  return (
    await raw.treatmentPlanItem.create({
      data: {
        tenantId: clinic.tenantId,
        planId,
        toothNumber: String(11 + (seq++ % 20)),
        catalogItemId: clinic.catalogItemId,
        price,
        status,
        completedAt: status === 'DONE' ? DAY : null,
      },
    })
  ).id;
}

/** Abono al plan (y su base en EUR, salvo `base: false`). */
async function pay(
  clinic: Clinic,
  planId: string,
  amount: number,
  opts: { paidAt?: Date; base?: boolean } = {},
): Promise<string> {
  const payment = await raw.payment.create({
    data: {
      tenantId: clinic.tenantId,
      locationId: clinic.locationId,
      treatmentPlanId: planId,
      patientId: clinic.patientId,
      amount,
      currency: 'EUR',
      paidAt: opts.paidAt ?? DAY,
    },
  });
  if (opts.base !== false) {
    await raw.paymentPlanAmount.create({
      data: {
        paymentId: payment.id,
        tenantId: clinic.tenantId,
        treatmentPlanId: planId,
        amount,
        currency: 'EUR',
        rateDate: DAY,
      },
    });
  }
  return payment.id;
}

async function fixture(clinic: Clinic = a): Promise<Fixture> {
  const planId = await plan(clinic);
  const done = await item(clinic, planId, 100, 'DONE');
  const accepted = await item(clinic, planId, 50, 'ACCEPTED');
  const paymentId = await pay(clinic, planId, 120);
  return { planId, done, accepted, paymentId };
}

/** Imputa como la app. */
function allocate(
  planId: string,
  paymentId: string,
  itemId: string,
  amount: number,
  source: 'AUTO' | 'MANUAL' = 'AUTO',
  clinic: Clinic = a,
) {
  return asApp(clinic.tenantId, (tx) =>
    tx.paymentAllocation.create({
      data: {
        tenantId: clinic.tenantId,
        paymentId,
        treatmentPlanId: planId,
        treatmentPlanItemId: itemId,
        amount,
        source,
      },
    }),
  );
}

/** Importe vivo imputado por abono a un ítem (0 si no hay fila). */
async function allocated(paymentId: string, itemId: string): Promise<number> {
  const row = await raw.paymentAllocation.findFirst({
    where: { paymentId, treatmentPlanItemId: itemId },
  });
  return row ? Number(row.amount) : 0;
}

const queued = (planId: string) =>
  raw.planAllocationRebalanceRequest.count({
    where: { treatmentPlanId: planId },
  });

/** UPDATE de un ítem como la app (lo que hacen los repositorios). */
function updateItem(itemId: string, set: string, clinic: Clinic = a) {
  return asApp(clinic.tenantId, (tx) =>
    tx.$executeRawUnsafe(
      `UPDATE "treatment_plan_items" SET ${set} WHERE "id" = $1::uuid`,
      itemId,
    ),
  );
}

function updatePlan(planId: string, set: string, clinic: Clinic = a) {
  return asApp(clinic.tenantId, (tx) =>
    tx.$executeRawUnsafe(
      `UPDATE "treatment_plans" SET ${set} WHERE "id" = $1::uuid`,
      planId,
    ),
  );
}

/** Espera a que haya `n` sesiones de esta base esperando un bloqueo. */
async function waitForLockWaiters(n: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [{ waiting }] = await raw.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no llegaron ${n} esperas de bloqueo`);
}

describe('imputación de abonos: tablas, RLS, guardas, liberación y cola (int, DX-051)', () => {
  beforeAll(async () => {
    await cleanup();
    await raw.user.deleteMany({ where: { email: EMAIL } });
    userId = (
      await raw.user.create({
        data: { email: EMAIL, passwordHash: 'x', fullName: 'Rita Recepción' },
      })
    ).id;
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await raw.user.deleteMany({ where: { email: EMAIL } });
    await raw.$disconnect();
    await appRole.$disconnect();
  });

  it('rls hides rows of another tenant', async () => {
    const f = await fixture();
    await allocate(f.planId, f.paymentId, f.done, 100);
    const seenBy = (clinic: Clinic) =>
      asApp(clinic.tenantId, async (tx) => {
        const out: Record<string, number> = {};
        for (const table of TABLES) {
          const [row] = await tx.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1::uuid`,
            a.tenantId,
          );
          out[table] = row.n;
        }
        return out;
      });
    const own = await seenBy(a);
    for (const table of TABLES) expect(own[table]).toBeGreaterThan(0);
    expect(await seenBy(b)).toEqual(
      Object.fromEntries(TABLES.map((t) => [t, 0])),
    );
    // B tampoco escribe filas de A.
    await expect(
      asApp(
        b.tenantId,
        (tx) =>
          tx.$executeRaw`INSERT INTO "plan_allocation_rebalance_requests" ("tenantId", "treatmentPlanId")
          VALUES (${a.tenantId}::uuid, ${f.planId}::uuid)`,
      ),
    ).rejects.toThrow(/row-level security/);
    const forced = await raw.$queryRaw<{ relforcerowsecurity: boolean }[]>`
      SELECT relforcerowsecurity FROM pg_class
       WHERE relname IN (${Prisma.join([...TABLES])})`;
    expect(forced).toHaveLength(4);
    expect(forced.every((r) => r.relforcerowsecurity)).toBe(true);
  });

  it('rejects an allocation whose item belongs to another plan', async () => {
    const f = await fixture();
    const other = await plan(a);
    const foreignItem = await item(a, other, 100, 'DONE');
    await expect(
      allocate(f.planId, f.paymentId, foreignItem, 10),
    ).rejects.toMatchObject(FK_VIOLATION);
    // Tampoco declarando el plan del ítem: el abono no es de ese plan.
    await expect(
      allocate(other, f.paymentId, foreignItem, 10),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('rejects an allocation for an opening-balance payment', async () => {
    const f = await fixture();
    const batch = await raw.patientImportBatch.create({
      data: {
        tenantId: a.tenantId,
        createdById: userId,
        locationId: a.locationId,
        fileName: 'p.csv',
        fileSha256: createHash('sha256').update(randomUUID()).digest('hex'),
        fileFormat: 'CSV',
        fileSizeBytes: 10,
        columnMapping: {},
        totalRows: 1,
        validRows: 1,
        duplicateRows: 0,
        errorRows: 0,
        preparedRows: 1,
      },
    });
    const opening = await raw.openingBalance.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.locationId,
        patientId: a.patientId,
        importBatchId: batch.id,
        currency: 'EUR',
        amount: 500,
        asOfDate: DAY,
        concept: 'Saldo anterior',
        createdById: userId,
      },
    });
    const payment = await raw.payment.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.locationId,
        openingBalanceId: opening.id,
        patientId: a.patientId,
        amount: 50,
        currency: 'EUR',
        paidAt: DAY,
      },
    });
    // Ni base (el abono no es de ningún plan) ni, por tanto, imputación.
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.paymentPlanAmount.create({
          data: {
            paymentId: payment.id,
            tenantId: a.tenantId,
            treatmentPlanId: f.planId,
            amount: 50,
            currency: 'EUR',
            rateDate: DAY,
          },
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
    await expect(
      allocate(f.planId, payment.id, f.done, 10),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('rejects an allocation without a base', async () => {
    const f = await fixture();
    const unconverted = await pay(a, f.planId, 30, { base: false });
    await expect(
      allocate(f.planId, unconverted, f.done, 10),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('rejects non-positive amounts', async () => {
    const f = await fixture();
    const unconverted = await pay(a, f.planId, 30, { base: false });
    for (const amount of [0, -5]) {
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.paymentPlanAmount.create({
            data: {
              paymentId: unconverted,
              tenantId: a.tenantId,
              treatmentPlanId: f.planId,
              amount,
              currency: 'EUR',
              rateDate: DAY,
            },
          }),
        ),
      ).rejects.toThrow(AMOUNT_CHECK);
      await expect(
        allocate(f.planId, f.paymentId, f.done, amount),
      ).rejects.toThrow(AMOUNT_CHECK);
    }
  });

  it('base only allows updating manual', async () => {
    const f = await fixture();
    await asApp(a.tenantId, (tx) =>
      tx.paymentPlanAmount.update({
        where: { paymentId: f.paymentId },
        data: { manual: true },
      }),
    );
    expect(
      (
        await raw.paymentPlanAmount.findUniqueOrThrow({
          where: { paymentId: f.paymentId },
        })
      ).manual,
    ).toBe(true);
    // La app no tiene UPDATE de otras columnas ni DELETE.
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.paymentPlanAmount.update({
          where: { paymentId: f.paymentId },
          data: { amount: 999 },
        }),
      ),
    ).rejects.toThrow(DENIED);
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.paymentPlanAmount.delete({ where: { paymentId: f.paymentId } }),
      ),
    ).rejects.toThrow(DENIED);
    // Y el trigger lo impide a cualquier rol (también con un GRANT de más).
    await expect(
      raw.paymentPlanAmount.update({
        where: { paymentId: f.paymentId },
        data: { amount: 999 },
      }),
    ).rejects.toThrow(/La base de un abono no cambia/);
  });

  it('allocation update only allows amount and stamps updatedAt in UTC', async () => {
    const f = await fixture();
    const row = await allocate(f.planId, f.paymentId, f.done, 50);
    const drift = await asApp(a.tenantId, async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'America/Bogota'`);
      await tx.paymentAllocation.update({
        where: { id: row.id },
        // Lo que mande la API en updatedAt no cuenta.
        data: { amount: 40, updatedAt: new Date('2001-01-01T00:00:00.000Z') },
      });
      const [r] = await tx.$queryRaw<{ drift: number }[]>`
        SELECT abs(extract(epoch FROM ("updatedAt" - (now() AT TIME ZONE 'UTC'))))::float8 AS drift
          FROM "payment_allocations" WHERE "id" = ${row.id}::uuid`;
      return r.drift;
    });
    expect(drift).toBeLessThan(1);
    expect(await allocated(f.paymentId, f.done)).toBe(40);
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.paymentAllocation.update({
          where: { id: row.id },
          data: { source: 'MANUAL' },
        }),
      ),
    ).rejects.toThrow(DENIED);
    await expect(
      raw.paymentAllocation.update({
        where: { id: row.id },
        data: { treatmentPlanItemId: f.accepted },
      }),
    ).rejects.toThrow(/Una imputación solo cambia de importe/);
  });

  it('guard rejects exceeding the item billable', async () => {
    const f = await fixture();
    await allocate(f.planId, f.paymentId, f.done, 80);
    const second = await pay(a, f.planId, 50);
    await expect(allocate(f.planId, second, f.done, 30)).rejects.toThrow(
      ITEM_EXCEEDED,
    );
    // Justo hasta el facturable, sí.
    await allocate(f.planId, second, f.done, 20);
    expect(await allocated(second, f.done)).toBe(20);
  });

  it('guard rejects exceeding the payment base', async () => {
    const f = await fixture();
    await allocate(f.planId, f.paymentId, f.done, 100);
    await expect(
      allocate(f.planId, f.paymentId, f.accepted, 30),
    ).rejects.toThrow(BASE_EXCEEDED);
    // Subir por UPDATE también pasa por la red.
    const row = await allocate(f.planId, f.paymentId, f.accepted, 20);
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.paymentAllocation.update({
          where: { id: row.id },
          data: { amount: 21 },
        }),
      ),
    ).rejects.toThrow(BASE_EXCEEDED);
  });

  it('guard rejects PROPOSED items and voided payments', async () => {
    const f = await fixture();
    const proposed = await item(a, f.planId, 70, 'PROPOSED');
    await expect(allocate(f.planId, f.paymentId, proposed, 10)).rejects.toThrow(
      ITEM_EXCEEDED,
    );
    await raw.payment.update({
      where: { id: f.paymentId },
      data: {
        deletedAt: new Date(),
        voidedAt: new Date(),
        voidedById: userId,
        voidReason: 'Duplicado',
      },
    });
    await expect(allocate(f.planId, f.paymentId, f.done, 10)).rejects.toThrow(
      VOIDED,
    );
  });

  it('guard rejects a base whose currency no longer matches the plan', async () => {
    const f = await fixture();
    await raw.treatmentPlan.update({
      where: { id: f.planId },
      data: { currency: 'USD' },
    });
    await expect(allocate(f.planId, f.paymentId, f.done, 10)).rejects.toThrow(
      CURRENCY_CHANGED,
    );
  });

  it('guard allows lowering an amount', async () => {
    const f = await fixture();
    const row = await allocate(f.planId, f.paymentId, f.done, 80);
    // Con el abono ya anulado (la red rechazaría subir), bajar sí pasa.
    await raw.payment.update({
      where: { id: f.paymentId },
      data: {
        deletedAt: new Date(),
        voidedAt: new Date(),
        voidedById: userId,
        voidReason: 'Duplicado',
      },
    });
    await asApp(a.tenantId, (tx) =>
      tx.paymentAllocation.update({
        where: { id: row.id },
        data: { amount: 50 },
      }),
    );
    expect(await allocated(f.paymentId, f.done)).toBe(50);
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.paymentAllocation.update({
          where: { id: row.id },
          data: { amount: 60 },
        }),
      ),
    ).rejects.toThrow(VOIDED);
  });

  it('discount releases newest allocations first', async () => {
    const planId = await plan(a);
    const done = await item(a, planId, 100, 'DONE');
    const p1 = await pay(a, planId, 60, {
      paidAt: new Date('2026-10-01T12:00:00.000Z'),
    });
    const p2 = await pay(a, planId, 40, {
      paidAt: new Date('2026-10-02T12:00:00.000Z'),
    });
    await allocate(planId, p1, done, 60);
    await allocate(planId, p2, done, 40);
    const before = await queued(planId);
    await updateItem(done, `"discount" = 30`);
    expect(await allocated(p1, done)).toBe(60);
    expect(await allocated(p2, done)).toBe(10);
    expect(await queued(planId)).toBe(before + 1);
  });

  it('release cuts AUTO allocations before MANUAL ones', async () => {
    // El AUTO es el MÁS ANTIGUO y el MANUAL el más reciente: solo «primero las
    // AUTO» (M1) deja el MANUAL entero; «de la más reciente a la más antigua» a
    // secas recortaría el MANUAL.
    const planId = await plan(a);
    const done = await item(a, planId, 100, 'DONE');
    const older = await pay(a, planId, 60, {
      paidAt: new Date('2026-10-01T12:00:00.000Z'),
    });
    const newer = await pay(a, planId, 40, {
      paidAt: new Date('2026-10-02T12:00:00.000Z'),
    });
    await allocate(planId, older, done, 60, 'AUTO');
    await allocate(planId, newer, done, 40, 'MANUAL');
    await updateItem(done, `"discount" = 50`);
    expect(await allocated(older, done)).toBe(10);
    expect(await allocated(newer, done)).toBe(40);
  });

  it('release cuts MANUAL allocations only after every AUTO one, newest first', async () => {
    const planId = await plan(a);
    const done = await item(a, planId, 100, 'DONE');
    const p1 = await pay(a, planId, 60, {
      paidAt: new Date('2026-10-01T12:00:00.000Z'),
    });
    const p2 = await pay(a, planId, 40, {
      paidAt: new Date('2026-10-02T12:00:00.000Z'),
    });
    await allocate(planId, p1, done, 60, 'MANUAL');
    await allocate(planId, p2, done, 40, 'AUTO');
    await updateItem(done, `"discount" = 50`);
    expect(await allocated(p1, done)).toBe(50);
    expect(await allocated(p2, done)).toBe(0);
  });

  it('release breaks paidAt ties by payment createdAt, then allocation id (newest first)', async () => {
    const planId = await plan(a);
    const done = await item(a, planId, 90, 'DONE');
    const paidAt = new Date('2026-10-03T12:00:00.000Z');
    // Mismo paidAt; el segundo abono se registra después (createdAt mayor).
    const first = await pay(a, planId, 30, { paidAt });
    const second = await pay(a, planId, 30, { paidAt });
    // Mismo paidAt y mismo createdAt (misma transacción): decide el id de la
    // imputación (uuid v7: la creada después es mayor).
    const [third, fourth] = await raw.$transaction(async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const p = await tx.payment.create({
          data: {
            tenantId: a.tenantId,
            locationId: a.locationId,
            treatmentPlanId: planId,
            patientId: a.patientId,
            amount: 15,
            currency: 'EUR',
            paidAt,
          },
        });
        await tx.paymentPlanAmount.create({
          data: {
            paymentId: p.id,
            tenantId: a.tenantId,
            treatmentPlanId: planId,
            amount: 15,
            currency: 'EUR',
            rateDate: DAY,
          },
        });
        ids.push(p.id);
      }
      return ids;
    });
    await allocate(planId, first, done, 30);
    await allocate(planId, second, done, 30);
    await allocate(planId, third, done, 15);
    await allocate(planId, fourth, done, 15);
    // Sobran 20: todo del último creado (fourth, 15) y 5 del anterior (third).
    await updateItem(done, `"discount" = 20`);
    expect(await allocated(fourth, done)).toBe(0);
    expect(await allocated(third, done)).toBe(10);
    expect(await allocated(second, done)).toBe(30);
    expect(await allocated(first, done)).toBe(30);
    // Sobran 25 más: el resto de third (10) y 15 de second (createdAt mayor).
    await updateItem(done, `"discount" = 45`);
    expect(await allocated(third, done)).toBe(0);
    expect(await allocated(second, done)).toBe(15);
    expect(await allocated(first, done)).toBe(30);
  });

  it('a concurrent void of an AUTO row does not make the release cut a MANUAL pin', async () => {
    // Revisión I1: la liberación bloquea las filas ANTES de calcular lo que
    // sobra. Si sumara antes, contaría la fila AUTO que la anulación borra a la
    // vez y recortaría el MANUAL (70 -> 40), que el reparto nunca repone.
    for (let run = 0; run < 5; run++) {
      const planId = await plan(a);
      const done = await item(a, planId, 100, 'DONE');
      const pinned = await pay(a, planId, 70, {
        paidAt: new Date('2026-10-01T12:00:00.000Z'),
      });
      const voided = await pay(a, planId, 30, {
        paidAt: new Date('2026-10-02T12:00:00.000Z'),
      });
      await allocate(planId, pinned, done, 70, 'MANUAL');
      await allocate(planId, voided, done, 30, 'AUTO');

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let deleted!: () => void;
      const deletedOpen = new Promise<void>((resolve) => {
        deleted = resolve;
      });
      // A: anulación (R12) con el DELETE hecho y la transacción abierta.
      const voiding = asApp(a.tenantId, async (tx) => {
        await tx.$executeRaw`SET LOCAL app.allocation_cause = 'VOID'`;
        await tx.paymentAllocation.deleteMany({ where: { paymentId: voided } });
        deleted();
        await held;
      });
      await deletedOpen;
      // B: descuento de 30 (facturable 70); espera a la fila que A borró.
      const discount = updateItem(done, `"discount" = 30`);
      await waitForLockWaiters(1);
      release();
      await Promise.all([voiding, discount]);

      expect(await allocated(pinned, done)).toBe(70);
      expect(await allocated(voided, done)).toBe(0);
      const causes = await raw.paymentAllocationMovement.findMany({
        where: { treatmentPlanId: planId, cause: 'RELEASE' },
      });
      expect(causes).toEqual([]);
    }
  });

  describe('every path that lowers the billable releases and enqueues', () => {
    it('item back to PROPOSED releases', async () => {
      const f = await fixture();
      await allocate(f.planId, f.paymentId, f.accepted, 50);
      const before = await queued(f.planId);
      await updateItem(f.accepted, `"status" = 'PROPOSED'`);
      expect(await allocated(f.paymentId, f.accepted)).toBe(0);
      expect(await queued(f.planId)).toBe(before + 1);
    });

    it('soft delete releases', async () => {
      const f = await fixture();
      await allocate(f.planId, f.paymentId, f.done, 100);
      await updateItem(f.done, `"deletedAt" = now()`);
      expect(await allocated(f.paymentId, f.done)).toBe(0);
    });

    it('lowering the price releases only the excess', async () => {
      const f = await fixture();
      await allocate(f.planId, f.paymentId, f.done, 100);
      await updateItem(f.done, `"price" = 75`);
      expect(await allocated(f.paymentId, f.done)).toBe(75);
    });

    it('plan CANCELLED releases', async () => {
      const f = await fixture();
      await allocate(f.planId, f.paymentId, f.done, 70);
      await allocate(f.planId, f.paymentId, f.accepted, 50);
      const before = await queued(f.planId);
      await updatePlan(f.planId, `"status" = 'CANCELLED'`);
      expect(await allocated(f.paymentId, f.done)).toBe(0);
      expect(await allocated(f.paymentId, f.accepted)).toBe(0);
      expect(await queued(f.planId)).toBe(before + 1);
    });

    it('plan soft delete releases', async () => {
      const f = await fixture();
      await allocate(f.planId, f.paymentId, f.done, 70);
      const before = await queued(f.planId);
      await updatePlan(f.planId, `"deletedAt" = now()`);
      expect(await allocated(f.paymentId, f.done)).toBe(0);
      expect(await queued(f.planId)).toBe(before + 1);
    });

    it('sibling alternative rejected releases', async () => {
      const root = await plan(a, {
        status: 'PRESENTED',
        presentedAt: DAY,
        presentedLocationId: a.locationId,
      });
      await raw.treatmentPlan.update({
        where: { id: root },
        data: { optionGroupId: root, optionLabel: 'Opción A' },
      });
      const sibling = await plan(a, {
        status: 'PRESENTED',
        presentedAt: DAY,
        presentedLocationId: a.locationId,
        optionGroupId: root,
        optionLabel: 'Opción B',
      });
      const siblingItem = await item(a, sibling, 100, 'ACCEPTED');
      const payment = await pay(a, sibling, 100);
      await allocate(sibling, payment, siblingItem, 100);
      // Lo que hace plan-option-group al aceptar la opción A.
      await updatePlan(
        sibling,
        `"status" = 'REJECTED', "rejectedAt" = now(), "rejectionReason" = 'OTHER_OPTION_ACCEPTED'`,
      );
      expect(await allocated(payment, siblingItem)).toBe(0);
    });

    it('voiding a cancellation fee releases its item allocations', async () => {
      const f = await fixture();
      const policy = await raw.cancellationPolicyVersion.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          version: ++seq,
          noticeHours: 24,
          suggestedFee: 50,
          currency: 'EUR',
          createdById: userId,
        },
      });
      const start = new Date(Date.now() - (seq + 24) * 3_600_000);
      const appointment = await raw.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          patientId: a.patientId,
          providerId: randomUUID(),
          start,
          end: new Date(start.getTime() + 30 * 60_000),
          status: 'NO_SHOW',
          noShowMarkedAt: new Date(),
          policyVersionId: policy.id,
        },
      });
      const fee = await raw.cancellationFee.create({
        data: {
          tenantId: a.tenantId,
          appointmentId: appointment.id,
          patientId: a.patientId,
          locationId: a.locationId,
          policyVersionId: policy.id,
          status: 'CHARGED',
          amount: 50,
          currency: 'EUR',
          planItemId: f.accepted,
          createdById: userId,
        },
      });
      await allocate(f.planId, f.paymentId, f.accepted, 50);
      // La anulación como la hace la app (SEC-050): primero el cargo, luego el ítem.
      await asApp(a.tenantId, async (tx) => {
        await tx.$executeRaw`UPDATE "cancellation_fees"
          SET "voidedAt" = now(), "voidedById" = ${userId}::uuid,
              "voidReason" = 'Cargo generado por error'
          WHERE "id" = ${fee.id}::uuid`;
        await tx.$executeRaw`UPDATE "treatment_plan_items"
          SET "deletedAt" = now() WHERE "id" = ${f.accepted}::uuid`;
      });
      expect(await allocated(f.paymentId, f.accepted)).toBe(0);
    });
  });

  it('adding an ACCEPTED item or marking DONE enqueues the plan', async () => {
    const f = await fixture();
    const before = await queued(f.planId);
    const added = await asApp(a.tenantId, (tx) =>
      tx.treatmentPlanItem.create({
        data: {
          tenantId: a.tenantId,
          planId: f.planId,
          toothNumber: '21',
          catalogItemId: a.catalogItemId,
          price: 30,
          status: 'ACCEPTED',
        },
      }),
    );
    expect(await queued(f.planId)).toBe(before + 1);
    await updateItem(added.id, `"status" = 'DONE', "completedAt" = now()`);
    expect(await queued(f.planId)).toBe(before + 2);
  });

  it('an update that resends unchanged price does not enqueue', async () => {
    const f = await fixture();
    await allocate(f.planId, f.paymentId, f.done, 100);
    const before = await queued(f.planId);
    // Prisma reenvía los campos aunque no cambien.
    await asApp(a.tenantId, (tx) =>
      tx.treatmentPlanItem.update({
        where: { id: f.done },
        data: { price: 100, discount: 0, status: 'DONE', notes: 'Sin cambios' },
      }),
    );
    await updateItem(
      f.done,
      `"price" = "price", "discount" = "discount", "status" = "status", "completedAt" = "completedAt"`,
    );
    expect(await queued(f.planId)).toBe(before);
    expect(await allocated(f.paymentId, f.done)).toBe(100);
  });

  it('editing visits only does not release nor enqueue', async () => {
    const f = await fixture();
    await allocate(f.planId, f.paymentId, f.done, 100);
    const before = await queued(f.planId);
    await updateItem(f.done, `"visit" = 2, "visitLabel" = 'Segunda visita'`);
    expect(await queued(f.planId)).toBe(before);
    expect(await allocated(f.paymentId, f.done)).toBe(100);
  });

  it('enqueue is a plain insert: two writers leave two rows', async () => {
    const f = await fixture();
    const before = await queued(f.planId);
    const enqueue = (tx: Prisma.TransactionClient) =>
      tx.$executeRaw`INSERT INTO "plan_allocation_rebalance_requests" ("tenantId", "treatmentPlanId")
        VALUES (${a.tenantId}::uuid, ${f.planId}::uuid)`;
    // El primero encola y se queda con la transacción abierta; el segundo
    // encola el mismo plan y confirma sin esperarlo (sin único ni ON CONFLICT).
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstEnqueued!: () => void;
    const enqueued = new Promise<void>((resolve) => {
      firstEnqueued = resolve;
    });
    const first = asApp(a.tenantId, async (tx) => {
      await enqueue(tx);
      firstEnqueued();
      await held;
    });
    await enqueued;
    await asApp(a.tenantId, enqueue);
    expect(await queued(f.planId)).toBe(before + 1);
    release();
    await first;
    expect(await queued(f.planId)).toBe(before + 2);
    const indexes = await raw.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'plan_allocation_rebalance_requests'`;
    expect(indexes.filter((i) => /UNIQUE/.test(i.indexdef))).toHaveLength(1);
  });

  it('hard-deleting a plan cascades its queue rows', async () => {
    const planId = await plan(a);
    const itemId = await item(a, planId, 100, 'ACCEPTED');
    expect(await queued(planId)).toBeGreaterThan(0);
    await raw.treatmentPlanItem.delete({ where: { id: itemId } });
    await raw.treatmentPlan.delete({ where: { id: planId } });
    expect(await queued(planId)).toBe(0);
  });

  it('every allocation change writes a movement with its cause', async () => {
    const f = await fixture();
    const row = await allocate(f.planId, f.paymentId, f.done, 80);
    await asApp(a.tenantId, async (tx) => {
      await tx.$executeRaw`SET LOCAL app.allocation_cause = 'MANUAL'`;
      await tx.paymentAllocation.update({
        where: { id: row.id },
        data: { amount: 100 },
      });
    });
    await asApp(a.tenantId, async (tx) => {
      await tx.$executeRaw`UPDATE "treatment_plan_items" SET "discount" = 30 WHERE "id" = ${f.done}::uuid`;
      // Tras la liberación, la causa vuelve a la de la transacción (AUTO).
      await tx.paymentAllocation.create({
        data: {
          tenantId: a.tenantId,
          paymentId: f.paymentId,
          treatmentPlanId: f.planId,
          treatmentPlanItemId: f.accepted,
          amount: 20,
          source: 'AUTO',
        },
      });
    });
    const movements = (itemId: string) =>
      raw.paymentAllocationMovement.findMany({
        where: { paymentId: f.paymentId, treatmentPlanItemId: itemId },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
      });
    // `at` es el inicio de la transacción (ms) y el sufijo del id es
    // aleatorio: dos transacciones en el mismo ms pueden salir en cualquier
    // orden, así que se comparan como multiconjunto.
    const byCause = (rows: { cause: string; deltaCents: bigint }[]) =>
      rows
        .map((m) => [m.cause, Number(m.deltaCents)] as [string, number])
        .sort((x, y) => x[0].localeCompare(y[0]) || x[1] - y[1]);
    const live = async (itemId: string) =>
      Math.round((await allocated(f.paymentId, itemId)) * 100);
    const sum = (rows: { deltaCents: bigint }[]) =>
      rows.reduce((acc, r) => acc + Number(r.deltaCents), 0);

    let done = await movements(f.done);
    expect(byCause(done)).toEqual([
      ['AUTO', 8000],
      ['MANUAL', 2000],
      ['RELEASE', -3000],
    ]);
    expect(sum(done)).toBe(await live(f.done));
    const accepted = await movements(f.accepted);
    expect(byCause(accepted)).toEqual([['AUTO', 2000]]);
    expect(sum(accepted)).toBe(await live(f.accepted));

    // Anular el abono (R12): causa VOID y la suma vuelve a 0.
    await asApp(a.tenantId, async (tx) => {
      await tx.$executeRaw`SET LOCAL app.allocation_cause = 'VOID'`;
      await tx.paymentAllocation.deleteMany({
        where: { paymentId: f.paymentId },
      });
    });
    done = await movements(f.done);
    expect(byCause(done)).toContainEqual(['VOID', -7000]);
    expect(sum(done)).toBe(0);
    expect(sum(await movements(f.accepted))).toBe(0);

    // Historial: la app no lo reescribe ni lo borra.
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.paymentAllocationMovement.deleteMany({
          where: { paymentId: f.paymentId },
        }),
      ),
    ).rejects.toThrow(DENIED);
    // Ni lo escribe a mano: solo el trigger de payment_allocations.
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.paymentAllocationMovement.create({
          data: {
            tenantId: a.tenantId,
            paymentId: f.paymentId,
            treatmentPlanId: f.planId,
            treatmentPlanItemId: f.done,
            deltaCents: 999,
            cause: 'MANUAL',
          },
        }),
      ),
    ).rejects.toThrow(/lo escribe solo el trigger de payment_allocations/);
    await expect(
      appRole.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
        await tx.$executeRaw`SET LOCAL app.allocation_cause = 'OTRA'`;
        await tx.paymentAllocation.create({
          data: {
            tenantId: a.tenantId,
            paymentId: f.paymentId,
            treatmentPlanId: f.planId,
            treatmentPlanItemId: f.done,
            amount: 1,
            source: 'AUTO',
          },
        });
      }),
    ).rejects.toThrow(/cause_check/);
  });
});
