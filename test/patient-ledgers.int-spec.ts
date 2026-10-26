import {
  gate,
  settle,
  transactionId,
  waitForTransactionWaiters,
} from './support/postgres-concurrency';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// DX-155, capa DB de patient_ledgers: el resumen por paciente que lee la
// cartera. Cada escritura va POR LA MISMA RUTA que la app (runWithTenant, rol
// dentalix_app, sujeto a RLS) salvo las limpiezas; `raw` (DIRECT_URL, owner)
// siembra, limpia y calcula el ORÁCULO: las entradas de cada paciente leídas
// de las tablas fuente con Prisma, sin pasar por las funciones de la migración.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

interface Seeded {
  tenantId: string;
  userId: string;
  sede1: string;
  sede2: string;
  catalogItemId: string;
}

type Plan = [
  string,
  string,
  string,
  number,
  number,
  number,
  number | null,
  [string, number][] | null,
];
type Schedule = [
  string,
  string,
  string,
  string,
  number,
  number,
  [number, number, number][],
];
/** Saldo migrado (DX-262): [id, moneda, importe, 'AAAA-MM-DD', aproximada, abonado]. */
type Opening = [string, string, number, string, boolean, number];
interface LedgerRow {
  patientId: string;
  locationId: string | null;
  owing: boolean;
  ledger: { plans: Plan[]; paymentPlans: Schedule[]; openings: Opening[] };
}

let seq = 0;

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const user = await raw.user.create({
    data: {
      email: `${subdomain}@example.com`,
      passwordHash: 'x',
      fullName: `Dra ${subdomain}`,
    },
  });
  const sede1 = await raw.location.create({
    data: { tenantId, name: 'Sede 1' },
  });
  const sede2 = await raw.location.create({
    data: { tenantId, name: 'Sede 2' },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId,
      code: `c-${subdomain}`,
      kind: 'PROCEDURE',
      labelEs: 'Resina',
      color: '#123456',
    },
  });
  return {
    tenantId,
    userId: user.id,
    sede1: sede1.id,
    sede2: sede2.id,
    catalogItemId: catalog.id,
  };
}

async function cleanup(seeds: Seeded[]): Promise<void> {
  const where = { tenantId: { in: seeds.map((s) => s.tenantId) } };
  await raw.installment.deleteMany({ where });
  await raw.paymentPlan.deleteMany({ where });
  // DX-051: los abonos por repositorio dejan base, imputaciones e historial
  // (borrar las imputaciones deja su movimiento: van antes).
  await raw.paymentAllocation.deleteMany({ where });
  await raw.paymentAllocationMovement.deleteMany({ where });
  await raw.paymentPlanAmount.deleteMany({ where });
  await raw.payment.deleteMany({ where });
  await raw.treatmentPlanAcceptance.deleteMany({ where });
  await raw.treatmentPlanItem.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.appointment.deleteMany({ where });
  // El resumen se va con el paciente (FK con CASCADE).
  await raw.patient.deleteMany({ where });
  await raw.dentalCatalogItem.deleteMany({ where });
  await raw.locationSchedule.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({
    where: { id: { in: seeds.map((s) => s.tenantId) } },
  });
  await raw.user.deleteMany({
    where: { id: { in: seeds.map((s) => s.userId) } },
  });
}

/** Lo que hay en el resumen (como owner: sin RLS). */
async function ledgersOf(tenantId: string): Promise<LedgerRow[]> {
  return raw.$queryRaw<LedgerRow[]>`
    SELECT "patientId", "locationId", "owing", "ledger"
      FROM "patient_ledgers"
     WHERE "tenantId" = ${tenantId}::uuid
     ORDER BY "patientId"`;
}

const ms = (d: Date) => d.getTime();
const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
const newest = <T extends { id: string }>(
  rows: T[],
  at: (r: T) => number | null,
): T | undefined =>
  [...rows].sort(
    (a, b) =>
      (at(b) ?? -Infinity) - (at(a) ?? -Infinity) || b.id.localeCompare(a.id),
  )[0];

/**
 * El oráculo: las entradas de cada paciente con algún plan, leídas de las
 * tablas fuente con las reglas de la cartera (DX-145): sede de la deuda,
 * deudor, sumas por plan y planes de cuotas.
 */
async function expectedOf(tenantId: string): Promise<LedgerRow[]> {
  const patients = await raw.patient.findMany({
    where: {
      tenantId,
      OR: [{ treatmentPlans: { some: {} } }, { openingBalances: { some: {} } }],
    },
    include: {
      appointments: true,
      openingBalances: { include: { payments: true } },
      treatmentPlans: {
        include: {
          items: true,
          payments: true,
          acceptance: true,
          paymentPlans: { include: { installments: true } },
        },
      },
    },
    orderBy: { id: 'asc' },
  });
  return patients.map((pa) => {
    const live = pa.treatmentPlans.filter((p) => p.deletedAt === null);
    const visit = newest(
      pa.appointments.filter(
        (a) => a.status === 'COMPLETED' && a.deletedAt === null,
      ),
      (a) => ms(a.start),
    );
    const payment = newest(
      pa.treatmentPlans.flatMap((p) =>
        p.payments.filter((x) => x.deletedAt === null),
      ),
      (x) => ms(x.paidAt),
    );
    const presented = newest(
      live.filter((p) => p.presentedLocationId !== null),
      (p) => (p.presentedAt ? ms(p.presentedAt) : null),
    );
    const plans: Plan[] = [...live].sort(byId).map((p) => {
      const billable = p.items
        .filter(
          (i) =>
            i.deletedAt === null &&
            (i.status === 'ACCEPTED' || i.status === 'DONE'),
        )
        .reduce((s, i) => s + Number(i.price) - Number(i.discount), 0);
      const paid = p.payments.filter((x) => x.deletedAt === null);
      const own = paid
        .filter((x) => x.currency === p.currency)
        .reduce((s, x) => s + Number(x.amount), 0);
      const other = new Map<string, number>();
      for (const x of paid) {
        if (x.currency === p.currency) continue;
        other.set(x.currency, (other.get(x.currency) ?? 0) + Number(x.amount));
      }
      return [
        p.id,
        p.status,
        p.currency,
        ms(p.createdAt),
        ms(p.acceptance?.acceptedAt ?? p.presentedAt ?? p.createdAt),
        billable,
        own === 0 ? null : own,
        other.size === 0
          ? null
          : [...other.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ];
    });
    const paymentPlans: Schedule[] = live
      .flatMap((p) => p.paymentPlans)
      .filter((pp) => pp.deletedAt === null && pp.status !== 'CANCELLED')
      .sort(byId)
      .map((pp) => [
        pp.id,
        pp.treatmentPlanId,
        pp.currency,
        pp.status,
        Number(pp.downPayment),
        ms(pp.startDate),
        [...pp.installments]
          .sort((a, b) => a.sequence - b.sequence)
          .map((i) => [i.sequence, ms(i.dueDate), Number(i.amount)]),
      ]);
    // DX-262: saldos migrados vivos, por fecha de corte; deben enteros y, si
    // no hay otra, dan la sede de la deuda (la del último).
    const liveOpenings = pa.openingBalances.filter((o) => o.voidedAt === null);
    const openings: Opening[] = [...liveOpenings]
      .sort(
        (x, y) => ms(x.asOfDate) - ms(y.asOfDate) || x.id.localeCompare(y.id),
      )
      .map((o) => [
        o.id,
        o.currency,
        Number(o.amount),
        o.asOfDate.toISOString().slice(0, 10),
        o.asOfDateApproximate,
        o.payments
          .filter((x) => x.deletedAt === null && x.currency === o.currency)
          .reduce((sum, x) => sum + Number(x.amount), 0),
      ]);
    const lastOpening = newest(liveOpenings, (o) => ms(o.createdAt));
    return {
      patientId: pa.id,
      locationId:
        visit?.locationId ??
        payment?.locationId ??
        presented?.presentedLocationId ??
        lastOpening?.locationId ??
        null,
      owing:
        pa.deletedAt === null &&
        (plans.some(([, , , , , billable, own]) => billable > (own ?? 0)) ||
          openings.some(([, , amount, , , paid]) => amount > paid)),
      ledger: { plans, paymentPlans, openings },
    };
  });
}

async function expectInSync(s: Seeded): Promise<void> {
  expect(await ledgersOf(s.tenantId)).toEqual(await expectedOf(s.tenantId));
}

const GUARD = /restrict_violation|23001|lo mantiene la base de datos/;

describe('patient_ledgers: resumen por paciente mantenido por la BD (DX-155, int)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await prisma.onModuleInit();
    a = await seedClinic('ldg-int-a');
    b = await seedClinic('ldg-int-b');
  });

  afterAll(async () => {
    await cleanup([a, b]);
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function as<T>(s: Seeded, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(s.tenantId, fn);
  }

  async function newPatient(s: Seeded): Promise<string> {
    seq += 1;
    const p = await as(s, (tx) =>
      tx.patient.create({
        data: { tenantId: s.tenantId, firstName: 'Ana', lastName: `L${seq}` },
        select: { id: true },
      }),
    );
    return p.id;
  }

  async function newPlan(
    s: Seeded,
    patientId: string,
    currency = 'COP',
  ): Promise<string> {
    const p = await as(s, (tx) =>
      tx.treatmentPlan.create({
        data: { tenantId: s.tenantId, patientId, currency },
        select: { id: true },
      }),
    );
    return p.id;
  }

  async function addItem(
    s: Seeded,
    planId: string,
    price: number,
    extra: Partial<Prisma.TreatmentPlanItemUncheckedCreateInput> = {},
  ): Promise<string> {
    const i = await as(s, (tx) =>
      tx.treatmentPlanItem.create({
        data: {
          tenantId: s.tenantId,
          planId,
          toothNumber: '11',
          catalogItemId: s.catalogItemId,
          price,
          status: 'ACCEPTED',
          ...extra,
        },
        select: { id: true },
      }),
    );
    return i.id;
  }

  function pay(
    s: Seeded,
    planId: string,
    patientId: string,
    amount: number,
    options: {
      currency?: string;
      locationId?: string;
      tx?: Prisma.TransactionClient;
      paidAt?: Date;
    } = {},
  ): Promise<string> {
    const create = (client: Prisma.TransactionClient) =>
      client.payment
        .create({
          data: {
            tenantId: s.tenantId,
            locationId: options.locationId ?? s.sede1,
            treatmentPlanId: planId,
            patientId,
            amount,
            currency: options.currency ?? 'COP',
            paidAt: options.paidAt ?? new Date(),
            method: 'CASH',
          },
          select: { id: true },
        })
        .then((p) => p.id);
    return options.tx ? create(options.tx) : as(s, create);
  }

  async function visit(
    s: Seeded,
    patientId: string,
    locationId: string,
    daysAgo: number,
    status: 'COMPLETED' | 'SCHEDULED' = 'COMPLETED',
  ): Promise<string> {
    const start = new Date(Date.now() - daysAgo * 86400000);
    const appt = await as(s, (tx) =>
      tx.appointment.create({
        data: {
          tenantId: s.tenantId,
          locationId,
          patientId,
          providerId: s.userId,
          start,
          end: new Date(start.getTime() + 30 * 60000),
          status,
        },
        select: { id: true },
      }),
    );
    return appt.id;
  }

  const rowOf = async (s: Seeded, patientId: string) =>
    (await ledgersOf(s.tenantId)).find((r) => r.patientId === patientId);

  it('un paciente sin planes no tiene fila; el alta de un plan la crea', async () => {
    const ana = await newPatient(a);
    await visit(a, ana, a.sede1, 3);
    expect(await rowOf(a, ana)).toBeUndefined();
    const planId = await newPlan(a, ana);
    const row = await rowOf(a, ana);
    expect(row).toMatchObject({
      locationId: a.sede1,
      owing: false,
      ledger: { paymentPlans: [] },
    });
    expect(row?.ledger.plans.map((p) => p.slice(0, 3))).toEqual([
      [planId, 'DRAFT', 'COP'],
    ]);
    await expectInSync(a);
  });

  it('ítems: solo cuentan los vivos ACCEPTED o DONE, con su descuento', async () => {
    const ana = await newPatient(a);
    const planId = await newPlan(a, ana);
    const accepted = await addItem(a, planId, 100000, { discount: 10000 });
    const proposed = await addItem(a, planId, 50000, { status: 'PROPOSED' });
    await addItem(a, planId, 30000, { status: 'DONE' });
    expect((await rowOf(a, ana))?.ledger.plans[0][5]).toBe(120000);
    expect((await rowOf(a, ana))?.owing).toBe(true);

    await as(a, (tx) =>
      tx.treatmentPlanItem.update({
        where: { id: proposed },
        data: { status: 'ACCEPTED' },
      }),
    );
    await as(a, (tx) =>
      tx.treatmentPlanItem.update({
        where: { id: accepted },
        data: { price: 200000, discount: 0 },
      }),
    );
    await as(a, (tx) =>
      tx.treatmentPlanItem.update({
        where: { id: proposed },
        data: { deletedAt: new Date() },
      }),
    );
    expect((await rowOf(a, ana))?.ledger.plans[0][5]).toBe(230000);
    await expectInSync(a);

    // Borrado duro (owner, limpieza): también se descuenta.
    await raw.treatmentPlanItem.delete({ where: { id: accepted } });
    await expectInSync(a);
  });

  it('abonos: propios, en otra moneda, anulados y borrados; la sede sale del último abono', async () => {
    const ana = await newPatient(a);
    const planId = await newPlan(a, ana);
    await addItem(a, planId, 300000);
    const first = await pay(a, planId, ana, 100000, {
      paidAt: new Date(Date.now() - 86400000),
    });
    await pay(a, planId, ana, 50000, { locationId: a.sede2 });
    await pay(a, planId, ana, 10, { currency: 'USD' });
    await pay(a, planId, ana, 5, { currency: 'USD' });
    await pay(a, planId, ana, 7, { currency: 'EUR' });
    const row = await rowOf(a, ana);
    expect(row?.ledger.plans[0].slice(5)).toEqual([
      300000,
      150000,
      [
        ['EUR', 7],
        ['USD', 15],
      ],
    ]);
    await expectInSync(a);

    // Anulación: como la hace PrismaPaymentRepository.softDelete.
    await as(a, (tx) =>
      tx.payment.updateMany({
        where: { id: first, deletedAt: null },
        data: { deletedAt: new Date(), voidedAt: new Date() },
      }),
    );
    expect((await rowOf(a, ana))?.ledger.plans[0][6]).toBe(50000);
    // Un cambio que no toca las entradas (notas) no las descuadra.
    await as(a, (tx) =>
      tx.payment.updateMany({
        where: { treatmentPlanId: planId },
        data: { notes: 'revisado' },
      }),
    );
    await raw.payment.deleteMany({
      where: { treatmentPlanId: planId, currency: 'EUR' },
    });
    await expectInSync(a);
  });

  it('cambios del plan: moneda, estado, presentación, aceptación firmada y retirada', async () => {
    const ana = await newPatient(a);
    const planId = await newPlan(a, ana, 'USD');
    await addItem(a, planId, 1000);
    await pay(a, planId, ana, 200, { currency: 'USD' });
    await pay(a, planId, ana, 400000);
    await raw.payment.updateMany({
      where: { treatmentPlanId: planId },
      data: { deletedAt: new Date() },
    });
    // Sin abonos vivos ni citas: la sede es la de la presentación.
    await as(a, (tx) =>
      tx.treatmentPlan.update({
        where: { id: planId },
        data: {
          currency: 'COP',
          status: 'PRESENTED',
          presentedAt: new Date(),
          presentedLocationId: a.sede2,
        },
      }),
    );
    expect(await rowOf(a, ana)).toMatchObject({ locationId: a.sede2 });
    await expectInSync(a);

    const acceptedAt = new Date(Date.now() - 5 * 86400000);
    await as(a, (tx) =>
      tx.treatmentPlanAcceptance.create({
        data: {
          tenantId: a.tenantId,
          planId,
          patientId: ana,
          locationId: a.sede2,
          signerName: 'Ana',
          signature: 'iVBORw0KGgo=',
          content: { version: 1 },
          contentHash: 'a'.repeat(64),
          acceptanceHash: 'a'.repeat(64),
          acceptedAt,
          acceptedById: a.userId,
        },
      }),
    );
    expect((await rowOf(a, ana))?.ledger.plans[0][4]).toBe(ms(acceptedAt));
    await expectInSync(a);

    const second = await newPlan(a, ana);
    await addItem(a, second, 5000);
    await as(a, (tx) =>
      tx.treatmentPlan.update({
        where: { id: second },
        data: { deletedAt: new Date() },
      }),
    );
    expect((await rowOf(a, ana))?.ledger.plans).toHaveLength(1);
    await expectInSync(a);
  });

  it('planes de cuotas y cuotas: alta, cambio y cancelación', async () => {
    const ana = await newPatient(a);
    const planId = await newPlan(a, ana);
    await addItem(a, planId, 300000);
    const schedule = await as(a, (tx) =>
      tx.paymentPlan.create({
        data: {
          tenantId: a.tenantId,
          treatmentPlanId: planId,
          patientId: ana,
          currency: 'COP',
          totalToFinance: 300000,
          installmentsCount: 3,
          periodicity: 'MONTHLY',
          startDate: new Date('2026-01-01T00:00:00Z'),
          installments: {
            create: [1, 2, 3].map((n) => ({
              sequence: n,
              dueDate: new Date(`2026-0${n}-01T00:00:00Z`),
              amount: 100000,
            })),
          },
        },
        select: { id: true },
      }),
    );
    expect((await rowOf(a, ana))?.ledger.paymentPlans[0][6]).toHaveLength(3);
    await expectInSync(a);

    await as(a, (tx) =>
      tx.installment.updateMany({
        where: { paymentPlanId: schedule.id, sequence: 3 },
        data: { amount: 90000, dueDate: new Date('2026-04-01T00:00:00Z') },
      }),
    );
    await expectInSync(a);

    await as(a, (tx) =>
      tx.paymentPlan.update({
        where: { id: schedule.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      }),
    );
    expect((await rowOf(a, ana))?.ledger.paymentPlans).toEqual([]);
    await expectInSync(a);
  });

  it('citas: la sede es la de la última atendida, y cambia al atender, mover o anular', async () => {
    const ana = await newPatient(a);
    const planId = await newPlan(a, ana);
    await addItem(a, planId, 1000);
    await visit(a, ana, a.sede1, 10);
    const later = await visit(a, ana, a.sede2, 2, 'SCHEDULED');
    expect((await rowOf(a, ana))?.locationId).toBe(a.sede1);

    await as(a, (tx) =>
      tx.appointment.update({
        where: { id: later },
        data: { status: 'COMPLETED' },
      }),
    );
    expect((await rowOf(a, ana))?.locationId).toBe(a.sede2);

    await as(a, (tx) =>
      tx.appointment.update({
        where: { id: later },
        data: { deletedAt: new Date() },
      }),
    );
    expect((await rowOf(a, ana))?.locationId).toBe(a.sede1);
    await expectInSync(a);
  });

  it('un paciente retirado deja de deber; volver a activarlo lo devuelve', async () => {
    const ana = await newPatient(a);
    const planId = await newPlan(a, ana);
    await addItem(a, planId, 1000);
    await as(a, (tx) =>
      tx.patient.update({
        where: { id: ana },
        data: { deletedAt: new Date() },
      }),
    );
    expect((await rowOf(a, ana))?.owing).toBe(false);
    await as(a, (tx) =>
      tx.patient.update({ where: { id: ana }, data: { deletedAt: null } }),
    );
    expect((await rowOf(a, ana))?.owing).toBe(true);
    await expectInSync(a);
  });

  it('una sentencia con varios pacientes los recalcula a todos', async () => {
    const ids = [await newPatient(a), await newPatient(a), await newPatient(a)];
    await as(a, (tx) =>
      tx.treatmentPlan.createMany({
        data: ids.map((patientId) => ({
          tenantId: a.tenantId,
          patientId,
          currency: 'COP',
        })),
      }),
    );
    const plans = await raw.treatmentPlan.findMany({
      where: { patientId: { in: ids } },
      select: { id: true },
    });
    await as(a, (tx) =>
      tx.treatmentPlanItem.createMany({
        data: plans.map((p) => ({
          tenantId: a.tenantId,
          planId: p.id,
          toothNumber: '11',
          catalogItemId: a.catalogItemId,
          price: 1000,
          status: 'ACCEPTED' as const,
        })),
      }),
    );
    for (const id of ids) expect((await rowOf(a, id))?.owing).toBe(true);
    await expectInSync(a);
  });

  it('dos abonos simultáneos del mismo paciente cuentan los dos (bloqueo por paciente)', async () => {
    const ana = await newPatient(a);
    const planId = await newPlan(a, ana);
    await addItem(a, planId, 500000);
    // El primero abona y se queda con la transacción abierta; el segundo
    // abona mientras tanto y espera el bloqueo de la fila del resumen. Al
    // seguir, recalcula con una foto que ya ve el primero.
    const locked = gate<string>();
    const release = gate();
    const slow = settle(
      as(a, async (tx) => {
        await pay(a, planId, ana, 100000, { tx });
        locked.open(await transactionId(tx));
        await release.wait;
      }),
    );
    const xid = await locked.wait;
    const fast = settle(pay(a, planId, ana, 70000));
    const items = settle(
      Promise.all([addItem(a, planId, 1000), addItem(a, planId, 2000)]),
    );
    try {
      await waitForTransactionWaiters(raw, xid);
    } finally {
      release.open();
      for (const result of await Promise.all([slow, fast, items])) {
        expect(result.status).toBe('fulfilled');
      }
    }
    expect((await rowOf(a, ana))?.ledger.plans[0].slice(5, 7)).toEqual([
      503000, 170000,
    ]);
    await expectInSync(a);
  });

  it('el primer plan y una escritura simultánea del mismo paciente (aún sin fila) se ponen en fila', async () => {
    // Sin fila en el resumen no hay nada que bloquear: el bloqueo por
    // paciente no puede depender de que la fila exista. El primero da de alta
    // el primer plan (crea la fila) y se queda con la transacción abierta;
    // mientras, otro atiende una cita y otro retira al paciente. Si esos dos
    // no esperaran, el primero confirmaría una fila calculada sin ellos.
    const ana = await newPatient(a);
    const bea = await newPatient(a);
    const release = gate();
    const anaLocked = gate<string>();
    const beaLocked = gate<string>();
    const slow = (patientId: string, locked: ReturnType<typeof gate<string>>) =>
      as(a, async (tx) => {
        const plan = await tx.treatmentPlan.create({
          data: { tenantId: a.tenantId, patientId, currency: 'COP' },
          select: { id: true },
        });
        await tx.treatmentPlanItem.create({
          data: {
            tenantId: a.tenantId,
            planId: plan.id,
            toothNumber: '11',
            catalogItemId: a.catalogItemId,
            price: 5000,
            status: 'ACCEPTED',
          },
        });
        locked.open(await transactionId(tx));
        await release.wait;
      });
    const first = settle(
      Promise.all([slow(ana, anaLocked), slow(bea, beaLocked)]),
    );
    const [anaXid, beaXid] = await Promise.all([
      anaLocked.wait,
      beaLocked.wait,
    ]);
    const following = settle(
      Promise.all([
        visit(a, ana, a.sede2, 1),
        as(a, (tx) =>
          tx.patient.update({
            where: { id: bea },
            data: { deletedAt: new Date() },
          }),
        ),
      ]),
    );
    try {
      await Promise.all([
        waitForTransactionWaiters(raw, anaXid),
        waitForTransactionWaiters(raw, beaXid),
      ]);
    } finally {
      release.open();
      expect((await first).status).toBe('fulfilled');
      expect((await following).status).toBe('fulfilled');
    }
    expect((await rowOf(a, ana))?.locationId).toBe(a.sede2);
    expect((await rowOf(a, bea))?.owing).toBe(false);
    await expectInSync(a);
  });

  it('la otra clínica no ve el resumen de A, y A no ve el de B', async () => {
    const bea = await newPatient(b);
    const planB = await newPlan(b, bea);
    await addItem(b, planB, 999000);
    const seenByB = await as(b, (tx) =>
      tx.patientLedger.findMany({ select: { patientId: true } }),
    );
    expect(seenByB).toEqual([{ patientId: bea }]);
    const seenByA = await as(a, (tx) =>
      tx.patientLedger.findMany({ select: { tenantId: true } }),
    );
    expect(seenByA.length).toBeGreaterThan(0);
    expect(seenByA.every((r) => r.tenantId === a.tenantId)).toBe(true);
    await expectInSync(b);
  });

  it('la app no escribe el resumen directamente (ni el de su clínica)', async () => {
    const ana = await newPatient(a);
    await newPlan(a, ana);
    await expect(
      as(a, (tx) =>
        tx.patientLedger.update({
          where: {
            tenantId_patientId: { tenantId: a.tenantId, patientId: ana },
          },
          data: { owing: true },
        }),
      ),
    ).rejects.toThrow(GUARD);
    await expect(
      as(
        a,
        (tx) =>
          tx.$executeRaw`DELETE FROM "patient_ledgers" WHERE "patientId" = ${ana}::uuid`,
      ),
    ).rejects.toThrow(GUARD);
    const other = await newPatient(a);
    await expect(
      as(
        a,
        (tx) =>
          tx.$executeRaw`INSERT INTO "patient_ledgers" ("tenantId","patientId")
                         VALUES (${a.tenantId}::uuid, ${other}::uuid)`,
      ),
    ).rejects.toThrow(GUARD);
    // Ni el de otra clínica: además de la guarda, la RLS.
    await expect(
      as(b, (tx) =>
        tx.patientLedger.updateMany({
          where: { patientId: ana },
          data: { owing: true },
        }),
      ),
    ).resolves.toEqual({ count: 0 });
    await expectInSync(a);
  });

  it('una fila descuadrada (a mano, como owner) se repara recalculando al paciente', async () => {
    const ana = await newPatient(a);
    const planId = await newPlan(a, ana);
    await addItem(a, planId, 40000);
    await raw.$executeRaw`UPDATE "patient_ledgers" SET "owing" = false,
                           "ledger" = '{"plans": [], "paymentPlans": []}'
                           WHERE "patientId" = ${ana}::uuid`;
    await as(
      a,
      (tx) =>
        tx.$executeRaw`SELECT patient_ledgers_refresh(ARRAY[${a.tenantId}::uuid], ARRAY[${ana}::uuid])`,
    );
    await expectInSync(a);
  });

  it('un refresco que no ve al paciente (otro tenant, RLS) falla en vez de dejar la fila vieja', async () => {
    const ana = await newPatient(a);
    await newPlan(a, ana);
    await expect(
      as(
        b,
        (tx) =>
          tx.$executeRaw`SELECT patient_ledgers_refresh(ARRAY[${a.tenantId}::uuid], ARRAY[${ana}::uuid])`,
      ),
    ).rejects.toThrow(/no se ven 1 de 1 pacientes/);
  });

  it('borrar el paciente (owner) se lleva su fila', async () => {
    const ana = await newPatient(a);
    const planId = await newPlan(a, ana);
    await raw.treatmentPlan.delete({ where: { id: planId } });
    await raw.patient.delete({ where: { id: ana } });
    expect(await rowOf(a, ana)).toBeUndefined();
    await expectInSync(a);
  });

  it('las entradas se expanden en la consulta que las pide (sin recorrer toda la clínica por paciente)', async () => {
    const [{ patientId }] = await ledgersOf(a.tenantId);
    const plan = await raw.$queryRaw<{ 'QUERY PLAN': unknown }[]>`
      EXPLAIN (FORMAT JSON)
      SELECT * FROM patient_ledgers_compute() c
       WHERE c."tenantId" = ${a.tenantId}::uuid AND c."patientId" = ${patientId}::uuid`;
    const text = JSON.stringify(plan);
    // Expandida: el plan lee las tablas fuente, no una función opaca que
    // calcularía TODOS los pacientes para luego quedarse con uno.
    expect(text).not.toContain('Function Scan');
    expect(text).toContain('"Relation Name":"patients"');
  });
});
