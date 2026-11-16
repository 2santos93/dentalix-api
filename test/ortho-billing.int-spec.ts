import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaOrthoRepository } from '../src/modules/orthodontics/infrastructure/prisma-ortho.repository';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenants, purgeTenantsBySubdomain } from './support/tenant-purge';

// DX-285, capa DB del cobro de ortodoncia y los alineadores: RLS FORCE de las
// tres tablas, CHECK del reparto del honorario, guarda del honorario aceptado,
// FK compuestas por tenant y por caso, aceptación (ítems en el plan, inicial
// realizada), control que realiza su cargo SIN duplicarlo, cuotas que solo se
// informan, saldo vencido por SQL con reloj fijo en una sola ida a la BD.
// Se escribe como la app (runWithTenant, dentalix_app); `raw` (DIRECT_URL,
// owner) siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaOrthoRepository(prisma, tenantContext);

const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
const DAY_MS = 86_400_000;

interface Clinic {
  tenantId: string;
  locationId: string;
  userId: string;
  patients: string[];
}

async function seedClinic(subdomain: string, patients = 3): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain, orthodonticsEnabled: true },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Principal',
    }),
  });
  const user = await raw.user.create({
    data: {
      email: `dr@${subdomain}.test`,
      passwordHash: 'x',
      fullName: `Dra. ${subdomain}`,
    },
  });
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'DENTIST' },
  });
  const ids: string[] = [];
  for (let i = 0; i < patients; i++) {
    const p = await raw.patient.create({
      data: {
        tenantId: tenant.id,
        firstName: `Paciente${i}`,
        lastName: subdomain,
        phone: `+58412000000${i}`,
      },
    });
    ids.push(p.id);
  }
  return {
    tenantId: tenant.id,
    locationId: location.id,
    userId: user.id,
    patients: ids,
  };
}

const FEE = {
  feeCurrency: 'VES',
  feeTotal: new Prisma.Decimal(3_000_000),
  feeInitial: new Prisma.Decimal(600_000),
  feePerVisit: new Prisma.Decimal(90_000),
  feeVisitCount: 24,
  feeRetention: new Prisma.Decimal(240_000),
};

function caseData(
  c: Clinic,
  patientId: string,
  extra: Partial<Prisma.OrthoCaseUncheckedCreateInput> = {},
): Prisma.OrthoCaseUncheckedCreateInput {
  return {
    tenantId: c.tenantId,
    patientId,
    locationId: c.locationId,
    providerId: c.userId,
    createdById: c.userId,
    technique: 'METAL_BRACKETS',
    startDate: day('2026-06-01'),
    estimatedMonths: 24,
    plannedVisits: 24,
    ...extra,
  };
}

const asApp = <T>(
  c: Clinic,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) => prisma.runWithTenant(c.tenantId, fn);

/** Una evolución + su control y su cargo, en la MISMA transacción, como la app. */
async function visit(
  c: Clinic,
  patientId: string,
  caseId: string,
  visitDate: string,
): Promise<string> {
  return tenantContext.run(c.tenantId, () =>
    prisma.runWithTenant(c.tenantId, async (tx) => {
      const entry = await tx.clinicalEntry.create({
        data: {
          tenantId: c.tenantId,
          patientId,
          locationId: c.locationId,
          entryDate: day(visitDate),
          notes: 'Control de ortodoncia.',
          performedById: c.userId,
        },
      });
      const v = await tx.orthoVisit.create({
        data: {
          tenantId: c.tenantId,
          patientId,
          caseId,
          clinicalEntryId: entry.id,
          visitDate: day(visitDate),
          hygieneIndex: 2,
          authorId: c.userId,
        },
      });
      await repo.realizeVisitCharge(tx, {
        caseId,
        visitId: v.id,
        authorId: c.userId,
      });
      return v.id;
    }),
  );
}

const inA = <T>(c: Clinic, fn: () => Promise<T>) =>
  tenantContext.run(c.tenantId, fn);

describe('cobro de ortodoncia y alineadores (DX-285, int)', () => {
  let a: Clinic;
  let b: Clinic;
  let caseA: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeTenantsBySubdomain(raw, ['ortho-bill-a', 'ortho-bill-b']);
    await raw.user.deleteMany({
      where: {
        email: { in: ['dr@ortho-bill-a.test', 'dr@ortho-bill-b.test'] },
      },
    });
    a = await seedClinic('ortho-bill-a', 4);
    b = await seedClinic('ortho-bill-b', 1);
    caseA = (
      await asApp(a, (tx) =>
        tx.orthoCase.create({ data: caseData(a, a.patients[0], FEE) }),
      )
    ).id;
  });

  afterAll(async () => {
    await purgeTenants(raw, [a.tenantId, b.tenantId]);
    await raw.user.deleteMany({ where: { id: { in: [a.userId, b.userId] } } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  it('las tres tablas nuevas tienen RLS activada y forzada', async () => {
    const rows = await raw.$queryRaw<
      { relname: string; on: boolean; forced: boolean }[]
    >`SELECT relname, relrowsecurity AS on, relforcerowsecurity AS forced
        FROM pg_class
       WHERE relname IN ('ortho_case_charges', 'ortho_aligner_series', 'ortho_aligner_deliveries')
       ORDER BY 1`;
    expect(rows).toEqual([
      { relname: 'ortho_aligner_deliveries', on: true, forced: true },
      { relname: 'ortho_aligner_series', on: true, forced: true },
      { relname: 'ortho_case_charges', on: true, forced: true },
    ]);
  });

  describe('CHECK del reparto', () => {
    it('un reparto que no suma el total no se guarda (ni como la app ni como owner)', async () => {
      await expect(
        asApp(a, (tx) =>
          tx.orthoCase.update({
            where: { id: caseA },
            data: { feeVisitCount: 23 },
          }),
        ),
      ).rejects.toThrow(/ortho_cases_fee_check/);
      await expect(
        raw.orthoCase.update({
          where: { id: caseA },
          data: { feeTotal: new Prisma.Decimal(2_999_999.99) },
        }),
      ).rejects.toThrow(/ortho_cases_fee_check/);
    });

    it('todo o nada: un honorario a medias no se guarda', async () => {
      await expect(
        asApp(a, (tx) =>
          tx.orthoCase.create({
            data: caseData(a, a.patients[3], {
              status: 'RETENTION',
              statusChangedAt: new Date(),
              statusChangedById: a.userId,
              feeTotal: new Prisma.Decimal(100),
            }),
          }),
        ),
      ).rejects.toThrow(/ortho_cases_fee_check/);
    });
  });

  describe('aceptación', () => {
    let planId: string;

    it('sin plan ligado: abre un plan ACEPTADO, crea 26 ítems y la inicial queda hecha', async () => {
      const result = await inA(a, () =>
        repo.acceptFee({
          patientId: a.patients[0],
          caseId: caseA,
          actorId: a.userId,
          technique: 'METAL_BRACKETS',
        }),
      );
      expect(result).toMatchObject({
        outcome: 'OK',
        chargesCreated: 26,
        paymentPlanId: null,
      });
      if (result.outcome !== 'OK') throw new Error('no aceptado');
      planId = result.planId;
      const plan = await raw.treatmentPlan.findUniqueOrThrow({
        where: { id: planId },
        include: { items: { orderBy: { createdAt: 'asc' } } },
      });
      expect(plan).toMatchObject({ status: 'ACCEPTED', currency: 'VES' });
      expect(plan.items).toHaveLength(26);
      const done = plan.items.filter((i) => i.status === 'DONE');
      expect(done.map((i) => [i.notes, i.price.toNumber()])).toEqual([
        ['Ortodoncia: cuota inicial', 600_000],
      ]);
      expect(done[0]).toMatchObject({
        performedById: a.userId,
        performedLocationId: a.locationId,
      });
      const c = await raw.orthoCase.findUniqueOrThrow({ where: { id: caseA } });
      expect(c.treatmentPlanId).toBe(planId);
      expect(c.feeAcceptedAt).not.toBeNull();
      // Dos aceptaciones a la vez: la segunda ve el caso aceptado.
      await expect(
        inA(a, () =>
          repo.acceptFee({
            patientId: a.patients[0],
            caseId: caseA,
            actorId: a.userId,
            technique: 'METAL_BRACKETS',
          }),
        ),
      ).resolves.toEqual({ outcome: 'ALREADY_ACCEPTED' });
    });

    it('aceptado: ni el honorario ni el plan ligado cambian (guarda, también para el owner)', async () => {
      await expect(
        raw.orthoCase.update({
          where: { id: caseA },
          data: { treatmentPlanId: null },
        }),
      ).rejects.toThrow(/honorario aceptado/);
      await expect(
        asApp(a, (tx) =>
          tx.orthoCase.update({
            where: { id: caseA },
            data: { feeAcceptedAt: null, feeAcceptedById: null },
          }),
        ),
      ).rejects.toThrow(/honorario aceptado/);
    });

    it('el control 3 de 24 realiza 3 controles; un control no cobra dos veces', async () => {
      const visits: string[] = [];
      for (const d of ['2026-07-01', '2026-08-01', '2026-09-01']) {
        visits.push(await visit(a, a.patients[0], caseA, d));
      }
      // La misma realización otra vez (p. ej. un reintento): nada nuevo.
      await inA(a, () =>
        asApp(a, (tx) =>
          repo.realizeVisitCharge(tx, {
            caseId: caseA,
            visitId: visits[2],
            authorId: a.userId,
          }),
        ),
      );
      const charges = await raw.orthoCaseCharge.findMany({
        where: { caseId: caseA, kind: 'VISIT', visitId: { not: null } },
        orderBy: { sequence: 'asc' },
        include: { item: true },
      });
      expect(charges.map((c) => [c.sequence, c.visitId])).toEqual([
        [1, visits[0]],
        [2, visits[1]],
        [3, visits[2]],
      ]);
      expect(charges.every((c) => c.item.status === 'DONE')).toBe(true);
      // El único por control: ni el owner apunta un control a dos cargos.
      const fourth = await raw.orthoCaseCharge.findFirstOrThrow({
        where: { caseId: caseA, kind: 'VISIT', sequence: 4 },
      });
      await expect(
        raw.orthoCaseCharge.update({
          where: { id: fourth.id },
          data: { visitId: visits[0] },
        }),
      ).rejects.toThrow();
      const facts = await inA(a, () =>
        repo.accountFacts(a.patients[0], caseA, new Date()),
      );
      const billed = facts!.charges
        .filter((c) => c.done && !c.removed)
        .reduce((s, c) => s + c.billableCents, 0);
      expect(billed).toBe((600_000 + 3 * 90_000) * 100);
      expect(facts!.visitsDone).toBe(3);
    });

    it('la app no borra cargos; un cargo de otro caso o de un ítem ajeno no se crea', async () => {
      await expect(
        asApp(
          a,
          (tx) =>
            tx.$executeRaw`DELETE FROM "ortho_case_charges" WHERE "caseId" = ${caseA}::uuid`,
        ),
      ).rejects.toThrow(/permission denied/);
      const item = await raw.treatmentPlanItem.findFirstOrThrow({
        where: { planId },
      });
      // B no ve el caso de A: la FK compuesta por tenant lo impide.
      await expect(
        asApp(b, (tx) =>
          tx.orthoCaseCharge.create({
            data: {
              tenantId: b.tenantId,
              caseId: caseA,
              kind: 'VISIT',
              sequence: 30,
              planId,
              planItemId: item.id,
            },
          }),
        ),
      ).rejects.toThrow();
      // B no ve los cargos de A.
      const seen = await asApp(b, (tx) =>
        tx.orthoCaseCharge.count({ where: { caseId: caseA } }),
      );
      expect(seen).toBe(0);
    });

    it('saldo vencido por SQL: realizado hace 45 días (umbral 30) marca; con el abono imputado, no', async () => {
      const charges = await raw.orthoCaseCharge.findMany({
        where: { caseId: caseA },
        include: { item: true },
      });
      const done = charges.filter((c) => c.item.status === 'DONE');
      const completedAt = done[0].item.completedAt!;
      // Reloj fijo: 45 días después de la realización (mismo día civil).
      const at45 = new Date(completedAt.getTime() + 45 * DAY_MS);
      const at30 = new Date(completedAt.getTime() + 30 * DAY_MS);
      const flags = await inA(a, () =>
        repo.overdueFlags([a.patients[0], a.patients[1]], at45),
      );
      expect(flags.get(a.patients[0])).toEqual({
        hasOverdue: true,
        overdueDays: 45,
      });
      expect(flags.has(a.patients[1])).toBe(false);
      expect(
        (await inA(a, () => repo.overdueFlags([a.patients[0]], at30))).size,
      ).toBe(0);

      // Pagar cada cargo hecho: el abono imputado lo cubre.
      const payment = await raw.payment.create({
        data: {
          tenantId: a.tenantId,
          patientId: a.patients[0],
          treatmentPlanId: planId,
          locationId: a.locationId,
          amount: new Prisma.Decimal(870_000),
          currency: 'VES',
          method: 'CASH',
          paidAt: new Date(),
        },
      });
      await raw.paymentPlanAmount.upsert({
        where: { paymentId: payment.id },
        create: {
          paymentId: payment.id,
          tenantId: a.tenantId,
          treatmentPlanId: planId,
          amount: new Prisma.Decimal(870_000),
          currency: 'VES',
          rateDate: day('2026-09-01'),
        },
        update: {},
      });
      await raw.paymentAllocation.deleteMany({
        where: { paymentId: payment.id },
      });
      for (const c of done) {
        await raw.paymentAllocation.create({
          data: {
            tenantId: a.tenantId,
            paymentId: payment.id,
            treatmentPlanId: planId,
            treatmentPlanItemId: c.planItemId,
            amount: c.item.price,
            source: 'AUTO',
          },
        });
      }
      expect(
        (await inA(a, () => repo.overdueFlags([a.patients[0]], at45))).size,
      ).toBe(0);
    });

    it('con cuotas ACTIVE en el plan ligado no se crea ningún cargo: solo se informan', async () => {
      const plan = await raw.treatmentPlan.create({
        data: {
          tenantId: a.tenantId,
          patientId: a.patients[1],
          currency: 'VES',
          status: 'ACCEPTED',
          acceptedAt: new Date(),
        },
      });
      const pp = await raw.paymentPlan.create({
        data: {
          tenantId: a.tenantId,
          treatmentPlanId: plan.id,
          patientId: a.patients[1],
          currency: 'VES',
          totalToFinance: new Prisma.Decimal(3_000_000),
          installmentsCount: 24,
          periodicity: 'MONTHLY',
          startDate: new Date(),
        },
      });
      const c = await asApp(a, (tx) =>
        tx.orthoCase.create({
          data: caseData(a, a.patients[1], {
            ...FEE,
            treatmentPlanId: plan.id,
          }),
        }),
      );
      const result = await inA(a, () =>
        repo.acceptFee({
          patientId: a.patients[1],
          caseId: c.id,
          actorId: a.userId,
          technique: 'ALIGNERS',
        }),
      );
      expect(result).toEqual({
        outcome: 'OK',
        planId: plan.id,
        chargesCreated: 0,
        paymentPlanId: pp.id,
      });
      expect(
        await raw.treatmentPlanItem.count({ where: { planId: plan.id } }),
      ).toBe(0);
      expect(await raw.orthoCaseCharge.count({ where: { caseId: c.id } })).toBe(
        0,
      );
      // Un control no cobra nada.
      await visit(a, a.patients[1], c.id, '2026-07-01');
      expect(
        await raw.treatmentPlanItem.count({ where: { planId: plan.id } }),
      ).toBe(0);
    });

    it('plan ligado en borrador: no se aceptan los cargos', async () => {
      const plan = await raw.treatmentPlan.create({
        data: {
          tenantId: a.tenantId,
          patientId: a.patients[2],
          currency: 'VES',
        },
      });
      const c = await asApp(a, (tx) =>
        tx.orthoCase.create({
          data: caseData(a, a.patients[2], {
            ...FEE,
            treatmentPlanId: plan.id,
          }),
        }),
      );
      await expect(
        inA(a, () =>
          repo.acceptFee({
            patientId: a.patients[2],
            caseId: c.id,
            actorId: a.userId,
            technique: 'METAL_BRACKETS',
          }),
        ),
      ).resolves.toEqual({ outcome: 'PLAN_NOT_ACCEPTED' });
      await raw.treatmentPlan.update({
        where: { id: plan.id },
        data: { currency: 'USD' },
      });
      await expect(
        inA(a, () =>
          repo.acceptFee({
            patientId: a.patients[2],
            caseId: c.id,
            actorId: a.userId,
            technique: 'METAL_BRACKETS',
          }),
        ),
      ).resolves.toEqual({ outcome: 'PLAN_CURRENCY' });
    });
  });

  describe('alineadores', () => {
    let series: string;

    it('una serie y sus entregas son de solo alta; la entrega va con un control del MISMO caso', async () => {
      series = (
        await inA(a, () =>
          repo.createAlignerSeries({
            caseId: caseA,
            arch: 'BOTH',
            brand: 'Marca X',
            totalTrays: 20,
            daysPerTray: 14,
            refinementOfId: null,
            createdById: a.userId,
          }),
        )
      ).id;
      await expect(
        asApp(a, (tx) =>
          tx.orthoAlignerSeries.update({
            where: { id: series },
            data: { totalTrays: 30 },
          }),
        ),
      ).rejects.toThrow(/permission denied/);
      // Control de otro caso (el de patients[1]) → la FK compuesta lo rechaza.
      const otherVisit = await raw.orthoVisit.findFirstOrThrow({
        where: { tenantId: a.tenantId, patientId: a.patients[1] },
      });
      await expect(
        asApp(a, (tx) =>
          tx.orthoAlignerDelivery.create({
            data: {
              tenantId: a.tenantId,
              caseId: caseA,
              seriesId: series,
              fromTray: 1,
              toTray: 4,
              deliveredOn: day('2026-07-01'),
              visitId: otherVisit.id,
              createdById: a.userId,
            },
          }),
        ),
      ).rejects.toThrow(/ortho_aligner_deliveries_visit_fkey/);
    });

    it('entregas seguidas con el caso bloqueado; bandeja por fecha y «Sin bandejas: entregar»', async () => {
      const add = (fromTray: number, toTray: number, deliveredOn: string) =>
        inA(a, () =>
          repo.addAlignerDelivery({
            caseId: caseA,
            seriesId: series,
            visitId: null,
            createdById: a.userId,
            validate: (_s, previous) => {
              const last = previous.reduce((m, d) => Math.max(m, d.toTray), 0);
              return fromTray === last + 1
                ? { ok: true, value: { fromTray, toTray, deliveredOn } }
                : { ok: false, message: 'seguidas' };
            },
          }),
        );
      await expect(add(1, 4, '2026-09-01')).resolves.toMatchObject({
        outcome: 'OK',
      });
      await expect(add(6, 8, '2026-10-01')).resolves.toEqual({
        outcome: 'INVALID',
        message: 'seguidas',
      });
      // Dos a la vez con la misma bandeja: el caso bloqueado deja pasar una.
      const both = await Promise.all([
        add(5, 8, '2026-10-13'),
        add(5, 8, '2026-10-13'),
      ]);
      expect(both.map((r) => r.outcome).sort()).toEqual(['INVALID', 'OK']);
      const [view] = await inA(a, () =>
        repo.listAlignerSeries(caseA, '2026-11-16'),
      );
      // 01-09 + 4 × 14 = 27-10 empieza la 5; 10-11 la 6.
      expect(view).toMatchObject({
        state: 'IN_PROGRESS',
        currentTray: 6,
        lastDeliveredTray: 8,
      });
      const [late] = await inA(a, () =>
        repo.listAlignerSeries(caseA, '2026-12-30'),
      );
      expect(late).toMatchObject({ state: 'NEEDS_DELIVERY', currentTray: 8 });
    });

    it('B no ve las series ni las entregas de A', async () => {
      const seen = await asApp(b, async (tx) => [
        await tx.orthoAlignerSeries.count({ where: { caseId: caseA } }),
        await tx.orthoAlignerDelivery.count({ where: { caseId: caseA } }),
      ]);
      expect(seen).toEqual([0, 0]);
    });
  });
});
