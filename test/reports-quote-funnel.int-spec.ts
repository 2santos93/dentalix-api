import {
  ClinicRole,
  ExtraPermission,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaCatalogCurrencyReader } from '../src/modules/dental-catalog/infrastructure/prisma-catalog-currency-reader';
import { PrismaQuoteFunnelRepository } from '../src/modules/reports/infrastructure/prisma-quote-funnel.repository';
import {
  GetQuoteFunnelUseCase,
  QUOTE_FUNNEL_OWN_ONLY_MESSAGE,
  type QuoteFunnelInput,
  type QuoteFunnelReport,
} from '../src/modules/reports/application/use-cases/get-quote-funnel.use-case';
import { planToCatalogAmount } from '../src/modules/reports/domain/quote-funnel';
import { round2 } from '../src/shared/money/money';
import { resetDatabase } from './support/e2e-fixtures';
import {
  caracas,
  plusDays,
  quoteFunnelSeeding,
  type FunnelClinic,
} from './support/quote-funnel-fixtures';

// DX-558 · «Embudo de presupuestos» contra Postgres de verdad, como
// dentalix_app (DATABASE_URL, sin BYPASSRLS) con la clínica fijada por
// runWithTenant. `raw` (DIRECT_URL, owner) solo siembra. Cada mes del 2026 es
// un caso: octubre los números básicos, septiembre la aceptación parcial,
// agosto las alternativas A/B y los motivos, julio la moneda, junio el
// alcance por profesional y sede, mayo/abril el corte del día civil.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const MONTH = {
  nov25: { from: '2025-11-01', to: '2025-11-30' },
  dec25: { from: '2025-12-01', to: '2025-12-31' },
  jan: { from: '2026-01-01', to: '2026-01-31' },
  feb: { from: '2026-02-01', to: '2026-02-28' },
  mar: { from: '2026-03-01', to: '2026-03-31' },
  apr: { from: '2026-04-01', to: '2026-04-30' },
  may: { from: '2026-05-01', to: '2026-05-31' },
  jun: { from: '2026-06-01', to: '2026-06-30' },
  jul: { from: '2026-07-01', to: '2026-07-31' },
  aug: { from: '2026-08-01', to: '2026-08-31' },
  sep: { from: '2026-09-01', to: '2026-09-30' },
  oct: { from: '2026-10-01', to: '2026-10-31' },
};

/** Lo que lee el embudo: todo con RLS FORZADA por clínica. */
const SOURCE_TABLES = [
  'locations',
  'treatment_plans',
  'treatment_plan_items',
  'appointment_plan_items',
  'appointments',
  'payment_allocations',
  'patients',
  'clinic_memberships',
];

const { plan, scheduleItem, allocate, formerMember, clinic, withoutTriggers } =
  quoteFunnelSeeding(raw);

const step = (r: QuoteFunnelReport, key: string) => {
  const found = r.steps.find((s) => s.key === key);
  if (!found) throw new Error(`sin paso ${key}`);
  return found;
};

describe('Embudo de presupuestos en la BD (DX-558, int)', () => {
  const context = new TenantContextService();
  const prisma = new PrismaService(context);
  const repo = new PrismaQuoteFunnelRepository(prisma, context);
  const useCase = new GetQuoteFunnelUseCase(
    repo,
    new PrismaCatalogCurrencyReader(prisma, context),
  );
  let a: FunnelClinic;
  let b: FunnelClinic;
  let exMemberId: string;
  let partial: { root: string; pending: string; pendingItems: string[] };

  const admin = (c: FunnelClinic): QuoteFunnelInput['actor'] => ({
    userId: c.dentist.userId,
    role: ClinicRole.ADMIN,
    permissions: [],
  });
  const dentist = (
    c: FunnelClinic,
    permissions: ExtraPermission[] = [],
  ): QuoteFunnelInput['actor'] => ({
    userId: c.dentist.userId,
    role: ClinicRole.DENTIST,
    permissions,
  });
  const report = (
    c: FunnelClinic,
    period: { from: string; to: string },
    extra: Partial<QuoteFunnelInput> = {},
  ) =>
    context.run(c.tenantId, () =>
      useCase.execute({
        ...period,
        actor: admin(c),
        allowedLocationIds: 'ALL',
        ...extra,
      }),
    );

  async function seedOctober(c: FunnelClinic): Promise<void> {
    // 10 presentaciones: 4 aceptadas (100, 200, 300, 400; aceptadas a los
    // 1, 2, 3 y 4 días), 2 pendientes (500 c/u) y 4 rechazadas.
    const accepted: { id: string; items: string[] }[] = [];
    for (const [n, price] of [100, 200, 300, 400].entries()) {
      const presentedAt = caracas(`2026-10-${10 + n}`);
      accepted.push(
        await plan(c, {
          status: 'ACCEPTED',
          presentedAt,
          acceptedAt: plusDays(presentedAt, n + 1),
          items: [{ price, status: n === 1 ? 'DONE' : 'ACCEPTED' }],
        }),
      );
    }
    for (const day of ['2026-10-02', '2026-10-03']) {
      await plan(c, {
        status: 'PRESENTED',
        presentedAt: caracas(day),
        items: [{ price: 600, discount: 100 }],
      });
    }
    for (const [reason, price] of [
      ['PRICE', 100],
      ['PRICE', 200],
      ['FEAR', 300],
      ['SECOND_OPINION', 50],
    ] as const) {
      await plan(c, {
        status: 'REJECTED',
        presentedAt: caracas('2026-10-20'),
        rejectedAt: caracas('2026-10-25'),
        rejectionReason: reason,
        items: [{ price }],
      });
    }
    // Agendado: el 1.º con una cita (cancelada: se agendó igual); el 2.º
    // realizado sin cita (DX-470). El 4.º solo con una cita borrada y un
    // vínculo borrado: no se agendó. Cobrado: 150 del 3.º.
    await scheduleItem(c, accepted[0].items[0], { status: 'CANCELLED' });
    await scheduleItem(c, accepted[3].items[0], { appointmentDeleted: true });
    await scheduleItem(c, accepted[3].items[0], { linkDeleted: true });
    await allocate(c, accepted[2].id, accepted[2].items[0], 100);
    await allocate(c, accepted[2].id, accepted[2].items[0], 50);
    // Fuera: aceptado sin presentar, plan borrado, ítem borrado (no suma).
    await plan(c, {
      status: 'ACCEPTED',
      acceptedAt: caracas('2026-10-15'),
      items: [{ price: 999, status: 'ACCEPTED' }],
    });
    await plan(c, {
      status: 'PRESENTED',
      presentedAt: caracas('2026-10-15'),
      deletedAt: caracas('2026-10-16'),
      items: [{ price: 999 }],
    });
    await plan(c, {
      status: 'REJECTED',
      presentedAt: caracas('2026-10-21'),
      rejectedAt: caracas('2026-10-22'),
      rejectionReason: 'PRICE',
      deletedAt: caracas('2026-10-23'),
      items: [{ price: 999 }],
    });
  }

  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(raw);
    a = await clinic('dx558-a');
    b = await clinic('dx558-b');
    await seedOctober(a);
    await seedOctober(b);

    // Septiembre: aceptación parcial (DX-417). El original se acepta con 100;
    // 200 + 300 quedan en un pendiente PRESENTED con el mismo presentedAt.
    const presentedAt = caracas('2026-09-10');
    const root = await plan(a, {
      status: 'ACCEPTED',
      presentedAt,
      acceptedAt: plusDays(presentedAt, 2),
      items: [{ price: 100, status: 'ACCEPTED' }],
    });
    const pending = await plan(a, {
      status: 'PRESENTED',
      presentedAt,
      splitFromPlanId: root.id,
      items: [{ price: 200 }, { price: 300 }],
    });
    partial = {
      root: root.id,
      pending: pending.id,
      pendingItems: pending.items,
    };

    // Agosto: alternativas A/B y motivos.
    const ga = await plan(a, {
      status: 'REJECTED',
      presentedAt: caracas('2026-08-05'),
      rejectedAt: caracas('2026-08-07'),
      rejectionReason: 'OTHER_OPTION_ACCEPTED',
      items: [{ price: 700 }, { price: 300 }],
    });
    await raw.treatmentPlan.update({
      where: { id: ga.id },
      data: { optionGroupId: ga.id },
    });
    await plan(a, {
      status: 'ACCEPTED',
      presentedAt: caracas('2026-08-05'),
      acceptedAt: caracas('2026-08-07'),
      optionGroupId: ga.id,
      items: [{ price: 600, status: 'ACCEPTED' }],
    });
    // Grupo rechazado: A por precio (día 20), B por miedo (día 25, el último).
    const gh = await plan(a, {
      status: 'REJECTED',
      presentedAt: caracas('2026-08-12'),
      rejectedAt: caracas('2026-08-20'),
      rejectionReason: 'PRICE',
      items: [{ price: 800 }],
    });
    await raw.treatmentPlan.update({
      where: { id: gh.id },
      data: { optionGroupId: gh.id },
    });
    await plan(a, {
      status: 'REJECTED',
      presentedAt: caracas('2026-08-12'),
      rejectedAt: caracas('2026-08-25'),
      rejectionReason: 'FEAR',
      optionGroupId: gh.id,
      items: [{ price: 900 }],
    });
    // Rechazada + cancelada → rechazada; solo cancelada → cancelada.
    const gj = await plan(a, {
      status: 'CANCELLED',
      presentedAt: caracas('2026-08-14'),
      items: [{ price: 40 }],
    });
    await raw.treatmentPlan.update({
      where: { id: gj.id },
      data: { optionGroupId: gj.id },
    });
    await plan(a, {
      status: 'REJECTED',
      presentedAt: caracas('2026-08-14'),
      rejectedAt: caracas('2026-08-15'),
      rejectionReason: 'OTHER',
      optionGroupId: gj.id,
      items: [{ price: 60 }],
    });
    await plan(a, {
      status: 'CANCELLED',
      presentedAt: caracas('2026-08-16'),
      items: [{ price: 10 }],
    });
    // Grupo de julio con una opción presentada en agosto: es de julio.
    const gk = await plan(a, {
      status: 'PRESENTED',
      presentedAt: caracas('2026-07-31'),
      items: [{ price: 100 }],
    });
    await raw.treatmentPlan.update({
      where: { id: gk.id },
      data: { optionGroupId: gk.id },
    });
    await plan(a, {
      status: 'PRESENTED',
      presentedAt: caracas('2026-08-03'),
      optionGroupId: gk.id,
      items: [{ price: 50 }],
    });

    // Julio: un plan en VES con la tasa del ítem (1 USD = 36,5 VES) y otro
    // sin tasa (fuera de los importes, dentro de los números).
    const ves = await plan(a, {
      status: 'ACCEPTED',
      currency: 'VES',
      presentedAt: caracas('2026-07-10'),
      acceptedAt: caracas('2026-07-11'),
      items: [
        {
          price: 4000,
          status: 'ACCEPTED',
          catalogCurrency: 'USD',
          rate: { from: 1, to: 36.5 },
        },
      ],
    });
    await allocate(a, ves.id, ves.items[0], 2000);
    await plan(a, {
      status: 'PRESENTED',
      currency: 'VES',
      presentedAt: caracas('2026-07-12'),
      items: [{ price: 1000, catalogCurrency: 'USD' }],
    });

    // Junio: quién lo elaboró y en qué sede.
    exMemberId = await formerMember(a, 'Dra. Retirada');
    await plan(a, {
      status: 'ACCEPTED',
      presentedAt: caracas('2026-06-05'),
      acceptedAt: caracas('2026-06-06'),
      items: [{ price: 100, status: 'ACCEPTED' }],
    });
    await plan(a, {
      status: 'PRESENTED',
      presentedAt: caracas('2026-06-06'),
      locationId: a.norte,
      createdById: a.otherDentistId,
      items: [{ price: 200 }],
    });
    await plan(a, {
      status: 'PRESENTED',
      presentedAt: caracas('2026-06-07'),
      createdById: exMemberId,
      items: [{ price: 300 }],
    });
    await plan(a, {
      status: 'PRESENTED',
      presentedAt: caracas('2026-06-08'),
      locationId: a.norte,
      createdById: null,
      items: [{ price: 50 }],
    });
    // Sin sede (anterior a la sede de presentación): solo quien ve todas.
    await plan(a, {
      status: 'ACCEPTED',
      presentedAt: caracas('2026-06-15'),
      acceptedAt: caracas('2026-06-15', '15:00'),
      locationId: null,
      items: [{ price: 10, status: 'ACCEPTED' }],
    });

    // Marzo: la opción B se aceptó (la A pasó a OTHER_OPTION_ACCEPTED) y
    // después la clínica la canceló: se aceptó alguna vez, cuenta como
    // aceptada. Y un plan suelto aceptado y cancelado, con un ítem realizado.
    const gm = await plan(a, {
      status: 'REJECTED',
      presentedAt: caracas('2026-03-05'),
      rejectedAt: caracas('2026-03-08'),
      rejectionReason: 'OTHER_OPTION_ACCEPTED',
      items: [{ price: 900 }],
    });
    await raw.treatmentPlan.update({
      where: { id: gm.id },
      data: { optionGroupId: gm.id },
    });
    await plan(a, {
      status: 'CANCELLED',
      presentedAt: caracas('2026-03-05'),
      acceptedAt: caracas('2026-03-08'),
      optionGroupId: gm.id,
      items: [{ price: 400, status: 'ACCEPTED' }],
    });
    await plan(a, {
      status: 'CANCELLED',
      presentedAt: caracas('2026-03-10'),
      acceptedAt: caracas('2026-03-11'),
      items: [
        { price: 150, status: 'DONE' },
        { price: 50, status: 'ACCEPTED' },
      ],
    });

    // Nov. 2025: alternativa C creada desde el PENDIENTE P de una aceptación
    // parcial (P abre el grupo de C) y aceptada: no es otra presentación;
    // cuenta desde «aceptado», no en lo presentado.
    const nr = await plan(a, {
      status: 'ACCEPTED',
      presentedAt: caracas('2025-11-05'),
      acceptedAt: caracas('2025-11-06'),
      items: [{ price: 100, status: 'ACCEPTED' }],
    });
    const np = await plan(a, {
      status: 'REJECTED',
      presentedAt: caracas('2025-11-05'),
      rejectedAt: caracas('2025-11-09'),
      rejectionReason: 'OTHER_OPTION_ACCEPTED',
      splitFromPlanId: nr.id,
      items: [{ price: 500 }],
    });
    await raw.treatmentPlan.update({
      where: { id: np.id },
      data: { optionGroupId: np.id },
    });
    await plan(a, {
      status: 'ACCEPTED',
      presentedAt: caracas('2025-11-08'),
      acceptedAt: caracas('2025-11-09'),
      optionGroupId: np.id,
      items: [{ price: 200, status: 'ACCEPTED' }],
    });

    // Dic. 2025: la alternativa B se creó en borrador y se aceptó SIN
    // presentarse (DRAFT → ACCEPTED); la A presentada pasó a
    // OTHER_OPTION_ACCEPTED.
    const da = await plan(a, {
      status: 'REJECTED',
      presentedAt: caracas('2025-12-03'),
      rejectedAt: caracas('2025-12-06'),
      rejectionReason: 'OTHER_OPTION_ACCEPTED',
      items: [{ price: 800 }],
    });
    await raw.treatmentPlan.update({
      where: { id: da.id },
      data: { optionGroupId: da.id },
    });
    await plan(a, {
      status: 'ACCEPTED',
      presentedAt: null,
      locationId: null,
      acceptedAt: caracas('2025-12-06'),
      optionGroupId: da.id,
      items: [{ price: 300, status: 'ACCEPTED' }],
    });

    // Ene. 2026: un pendiente BORRADO a mitad de la cadena (R → P1 borrado →
    // P2 vivo): se atraviesa, P2 suma y P1 no.
    const jr = await plan(a, {
      status: 'ACCEPTED',
      presentedAt: caracas('2026-01-10'),
      acceptedAt: caracas('2026-01-11'),
      items: [{ price: 100, status: 'ACCEPTED' }],
    });
    const jp1 = await plan(a, {
      status: 'ACCEPTED',
      presentedAt: caracas('2026-01-10'),
      acceptedAt: caracas('2026-01-12'),
      splitFromPlanId: jr.id,
      deletedAt: caracas('2026-01-13'),
      items: [{ price: 200, status: 'ACCEPTED' }],
    });
    await plan(a, {
      status: 'PRESENTED',
      presentedAt: caracas('2026-01-10'),
      splitFromPlanId: jp1.id,
      items: [{ price: 300 }],
    });

    // Feb. 2026: un ítem BORRADO de un plan vivo aceptado, con cita e
    // imputación: no suma ni agenda ni cobra.
    const fb = await plan(a, {
      status: 'ACCEPTED',
      presentedAt: caracas('2026-02-10'),
      acceptedAt: caracas('2026-02-11'),
      items: [
        { price: 100, status: 'ACCEPTED' },
        { price: 999, status: 'ACCEPTED', deletedAt: caracas('2026-02-12') },
      ],
    });
    await scheduleItem(a, fb.items[1]);
    await allocate(a, fb.id, fb.items[1], 500);

    // Corte del día civil: 30/04 23:30 en Caracas es de abril (01/05 en UTC).
    await plan(a, {
      status: 'PRESENTED',
      presentedAt: new Date('2026-05-01T03:30:00Z'),
      items: [{ price: 1 }],
    });
    await plan(a, {
      status: 'PRESENTED',
      presentedAt: new Date('2026-05-01T04:30:00Z'),
      items: [{ price: 2 }],
    });
  }, 120_000);

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await raw.$disconnect();
  });

  it('corre como dentalix_app, sin BYPASSRLS', async () => {
    const [who] = await prisma.$queryRaw<
      { role: string; bypass: boolean }[]
    >`SELECT current_user AS role, rolbypassrls AS bypass
        FROM pg_roles WHERE rolname = current_user`;
    expect(who).toEqual({ role: 'dentalix_app', bypass: false });
  });

  it('las tablas que lee tienen RLS forzada', async () => {
    const rows = await raw.$queryRaw<
      { relname: string; enabled: boolean; forced: boolean }[]
    >`SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relname = ANY(${SOURCE_TABLES})`;
    expect(rows.map((r) => r.relname).sort()).toEqual(
      [...SOURCE_TABLES].sort(),
    );
    expect(rows.filter((r) => !r.enabled || !r.forced)).toEqual([]);
  });

  it('10 presentados y 4 aceptados: 40 % por número y su % por importe', async () => {
    const r = await report(a, MONTH.oct);
    expect(r.currency).toBe('USD');
    expect(r.scope).toBe('CLINIC');
    expect(step(r, 'PRESENTED')).toEqual({
      key: 'PRESENTED',
      count: 10,
      amount: 2650,
      rateOfPresented: 100,
      amountRateOfPresented: 100,
    });
    expect(step(r, 'ACCEPTED')).toMatchObject({
      count: 4,
      amount: 1000,
      rateOfPresented: 40,
    });
    // 1000 ÷ 2650 = 37,735… %
    expect(r.acceptanceRate).toEqual({ byCount: 40, byAmount: 37.7 });
    // Aceptados a los 1, 2, 3 y 4 días: mediana 2,5.
    expect(r.medianDaysToAccept).toBe(2.5);
    expect(r.outcomes).toEqual({
      pending: { count: 2, amount: 1000 },
      rejected: { count: 4, amount: 650 },
      cancelled: { count: 0, amount: 0 },
    });
    expect(r.withoutRate).toEqual({ presentations: 0 });
    expect(r.warnings).toEqual([]);
  });

  it('agendado (cita en cualquier estado o realizado), realizado y cobrado', async () => {
    const r = await report(a, MONTH.oct);
    expect(step(r, 'SCHEDULED')).toMatchObject({
      count: 2,
      amount: 300,
      rateOfPresented: 20,
    });
    expect(step(r, 'DONE')).toMatchObject({ count: 1, amount: 200 });
    // Dos imputaciones al mismo ítem: una presentación, 150.
    expect(step(r, 'COLLECTED')).toMatchObject({ count: 1, amount: 150 });
  });

  it('motivos de rechazo por número y luego por importe', async () => {
    const r = await report(a, MONTH.oct);
    expect(r.rejectionReasons).toEqual([
      { reason: 'PRICE', count: 2, amount: 300 },
      { reason: 'FEAR', count: 1, amount: 300 },
      { reason: 'SECOND_OPINION', count: 1, amount: 50 },
    ]);
  });

  it('parcial: entero por número, solo lo aceptado por importe; el pendiente suma al aceptarse', async () => {
    const before = await report(a, MONTH.sep);
    // El pendiente NO es otra presentación.
    expect(step(before, 'PRESENTED')).toMatchObject({ count: 1, amount: 600 });
    expect(step(before, 'ACCEPTED')).toMatchObject({ count: 1, amount: 100 });
    expect(before.medianDaysToAccept).toBe(2);

    // El pendiente se acepta en parte (200) y deja otro pendiente (300).
    await withoutTriggers(async (tx) => {
      await tx.treatmentPlan.update({
        where: { id: partial.pending },
        data: { status: 'ACCEPTED', acceptedAt: caracas('2026-09-30') },
      });
      await tx.treatmentPlanItem.update({
        where: { id: partial.pendingItems[0] },
        data: { status: 'ACCEPTED' },
      });
    });
    const second = await plan(a, {
      status: 'PRESENTED',
      presentedAt: caracas('2026-09-10'),
      splitFromPlanId: partial.pending,
      items: [],
    });
    await raw.treatmentPlanItem.update({
      where: { id: partial.pendingItems[1] },
      data: { planId: second.id },
    });
    const after = await report(a, MONTH.sep);
    expect(step(after, 'PRESENTED')).toMatchObject({ count: 1, amount: 600 });
    expect(step(after, 'ACCEPTED')).toMatchObject({ count: 1, amount: 300 });
    // La mediana usa la PRIMERA aceptación.
    expect(after.medianDaysToAccept).toBe(2);

    const detail = await context.run(a.tenantId, () =>
      useCase.presentations({
        ...MONTH.sep,
        actor: admin(a),
        allowedLocationIds: 'ALL',
        step: 'PRESENTED',
      }),
    );
    expect(detail.total).toBe(1);
    expect(detail.items[0]).toMatchObject({
      groupId: partial.root,
      firstPlanId: partial.root,
      optionCount: 1,
      presentedAmount: 600,
      acceptedAmount: 300,
      outcome: 'ACCEPTED',
    });
    expect([...detail.items[0].planIds].sort()).toEqual(
      [partial.root, partial.pending, second.id].sort(),
    );
  });

  it('A/B: una presentación con el total de la opción mayor; OTHER_OPTION_ACCEPTED no es rechazo', async () => {
    const r = await report(a, MONTH.aug);
    // A/B aceptado, A/B rechazado, rechazado + cancelado, cancelado (la
    // opción de agosto del grupo de julio no cuenta aquí).
    expect(step(r, 'PRESENTED')).toMatchObject({
      count: 4,
      amount: 1000 + 900 + 60 + 10,
    });
    expect(step(r, 'ACCEPTED')).toMatchObject({ count: 1, amount: 600 });
    expect(r.outcomes).toEqual({
      pending: { count: 0, amount: 0 },
      rejected: { count: 2, amount: 960 },
      cancelled: { count: 1, amount: 10 },
    });
    // El motivo de la opción rechazada MÁS RECIENTE; sin OTHER_OPTION_ACCEPTED.
    expect(r.rejectionReasons).toEqual([
      { reason: 'FEAR', count: 1, amount: 900 },
      { reason: 'OTHER', count: 1, amount: 60 },
    ]);
    const rejected = await context.run(a.tenantId, () =>
      useCase.presentations({
        ...MONTH.aug,
        actor: admin(a),
        allowedLocationIds: 'ALL',
        step: 'REJECTED',
        reason: 'FEAR',
      }),
    );
    expect(rejected.items).toEqual([
      expect.objectContaining({
        optionCount: 2,
        presentedAmount: 900,
        acceptedAmount: 0,
        outcome: 'REJECTED',
        rejectionReason: 'FEAR',
      }),
    ]);
  });

  it('un grupo es del mes de su primera presentación', async () => {
    const detail = await context.run(a.tenantId, () =>
      useCase.presentations({
        ...MONTH.jul,
        actor: admin(a),
        allowedLocationIds: 'ALL',
        step: 'PENDING',
      }),
    );
    const group = detail.items.find((i) => i.optionCount === 2);
    expect(group).toMatchObject({ presentedAmount: 100, outcome: 'PENDING' });
  });

  it('otra moneda: convertida con la tasa del ítem; sin tasa, aviso y fuera de los importes', async () => {
    const r = await report(a, MONTH.jul);
    const converted = round2(
      planToCatalogAmount(4000, { fromPerBase: 1, toPerBase: 36.5 }),
    );
    expect(converted).toBe(109.59);
    // VES con tasa + VES sin tasa + grupo de julio (100).
    expect(step(r, 'PRESENTED')).toMatchObject({
      count: 3,
      amount: round2(4000 / 36.5 + 100),
    });
    expect(step(r, 'ACCEPTED')).toMatchObject({ count: 1, amount: 109.59 });
    expect(step(r, 'COLLECTED')).toMatchObject({ count: 1, amount: 54.79 });
    expect(r.withoutRate).toEqual({ presentations: 1 });
    expect(r.warnings).toEqual(['WITHOUT_RATE']);
    expect(r.outcomes.pending).toEqual({ count: 2, amount: 100 });
    const detail = await context.run(a.tenantId, () =>
      useCase.presentations({
        ...MONTH.jul,
        actor: admin(a),
        allowedLocationIds: 'ALL',
        step: 'PENDING',
      }),
    );
    const withoutRate = detail.items.find((i) => i.optionCount === 1);
    expect(withoutRate).toMatchObject({
      presentedAmount: null,
      acceptedAmount: null,
      outcome: 'PENDING',
    });
  });

  it('sin moneda de catálogo: importes null y aviso; los números siguen', async () => {
    await raw.tenant.update({
      where: { id: a.tenantId },
      data: { catalogCurrency: null },
    });
    await raw.location.updateMany({
      where: { tenantId: a.tenantId, id: a.norte },
      data: { currency: 'USD' },
    });
    try {
      const r = await report(a, MONTH.oct);
      expect(r.currency).toBeNull();
      expect(r.warnings).toEqual(['NO_CATALOG_CURRENCY']);
      expect(step(r, 'PRESENTED')).toMatchObject({ count: 10, amount: null });
      expect(r.acceptanceRate).toEqual({ byCount: 40, byAmount: null });
      expect(r.rejectionReasons[0]).toEqual({
        reason: 'PRICE',
        count: 2,
        amount: null,
      });
    } finally {
      await raw.location.updateMany({
        where: { tenantId: a.tenantId, id: a.norte },
        data: { currency: 'VES' },
      });
      await raw.tenant.update({
        where: { id: a.tenantId },
        data: { catalogCurrency: 'USD' },
      });
    }
  });

  it('por profesional (quien lo elaboró); ex-miembro y sin autor a «Sin atribuir»', async () => {
    const r = await report(a, MONTH.jun);
    expect(step(r, 'PRESENTED')).toMatchObject({ count: 5, amount: 660 });
    expect(
      r.byProfessional.map((p) => [p.professionalId, p.name, p.presented]),
    ).toEqual([
      [a.dentist.userId, 'Dra. Reportes', { count: 2, amount: 110 }],
      [a.otherDentistId, `Dr. Otro dx558-a`, { count: 1, amount: 200 }],
      [null, 'Sin atribuir', { count: 2, amount: 350 }],
    ]);
    const mine = r.byProfessional[0];
    expect(mine.accepted).toEqual({ count: 2, amount: 110 });
    expect(mine.acceptanceRate).toEqual({ byCount: 100, byAmount: 100 });
    // 1 día y 4 h → mediana 0,6 días.
    expect(mine.medianDaysToAccept).toBe(0.6);
    expect(r.options.professionals.map((p) => p.userId).sort()).toEqual(
      [a.dentist.userId, a.otherDentistId].sort(),
    );
  });

  it('DENTIST: solo lo suyo; pedir a otro es 403; con FINANCIAL_REPORTS_VIEW, la clínica', async () => {
    const own = await report(a, MONTH.jun, { actor: dentist(a) });
    expect(own.scope).toBe('OWN');
    expect(step(own, 'PRESENTED')).toMatchObject({ count: 2, amount: 110 });
    expect(own.byProfessional.map((p) => p.professionalId)).toEqual([
      a.dentist.userId,
    ]);
    expect(own.options.professionals.map((p) => p.userId)).toEqual([
      a.dentist.userId,
    ]);
    await expect(
      report(a, MONTH.jun, {
        actor: dentist(a),
        providerId: a.otherDentistId,
      }),
    ).rejects.toMatchObject({
      status: 403,
      message: QUOTE_FUNNEL_OWN_ONLY_MESSAGE,
    });
    const clinicWide = await report(a, MONTH.jun, {
      actor: dentist(a, [ExtraPermission.FINANCIAL_REPORTS_VIEW]),
      providerId: a.otherDentistId,
    });
    expect(clinicWide.scope).toBe('CLINIC');
    expect(step(clinicWide, 'PRESENTED')).toMatchObject({
      count: 1,
      amount: 200,
    });
  });

  it('restringido a una sede: solo lo presentado allí; otra sede es 403', async () => {
    const r = await report(a, MONTH.jun, { allowedLocationIds: [a.norte] });
    expect(r.restrictedToLocations).toBe(true);
    expect(step(r, 'PRESENTED')).toMatchObject({ count: 2, amount: 250 });
    expect(r.options.locations.map((l) => l.id)).toEqual([a.norte]);
    await expect(
      report(a, MONTH.jun, {
        allowedLocationIds: [a.norte],
        locationId: a.main,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const main = await report(a, MONTH.jun, { locationId: a.main });
    // Con una sede elegida, lo presentado sin sede no entra.
    expect(step(main, 'PRESENTED')).toMatchObject({ count: 2, amount: 400 });
  });

  it('aceptado y luego cancelado cuenta como aceptado (se aceptó alguna vez); la caída se ve después', async () => {
    const r = await report(a, MONTH.mar);
    expect(step(r, 'PRESENTED')).toMatchObject({ count: 2, amount: 900 + 200 });
    expect(step(r, 'ACCEPTED')).toMatchObject({ count: 2, amount: 400 + 200 });
    expect(step(r, 'DONE')).toMatchObject({ count: 1, amount: 150 });
    expect(r.outcomes).toEqual({
      pending: { count: 0, amount: 0 },
      rejected: { count: 0, amount: 0 },
      cancelled: { count: 0, amount: 0 },
    });
    expect(r.rejectionReasons).toEqual([]);
    // 3 días y 1 día: mediana 2.
    expect(r.medianDaysToAccept).toBe(2);
  });

  it('alternativa aceptada sin presentar (DRAFT → ACCEPTED): la presentación cuenta como aceptada', async () => {
    const r = await report(a, MONTH.dec25);
    expect(step(r, 'PRESENTED')).toMatchObject({ count: 1, amount: 800 });
    expect(step(r, 'ACCEPTED')).toMatchObject({ count: 1, amount: 300 });
    expect(r.outcomes.cancelled.count).toBe(0);
    expect(r.medianDaysToAccept).toBe(3);
    const detail = await context.run(a.tenantId, () =>
      useCase.presentations({
        ...MONTH.dec25,
        actor: admin(a),
        allowedLocationIds: 'ALL',
        step: 'ACCEPTED',
      }),
    );
    expect(detail.items).toEqual([
      expect.objectContaining({
        optionCount: 1,
        presentedAmount: 800,
        acceptedAmount: 300,
        outcome: 'ACCEPTED',
        locationId: a.main,
      }),
    ]);
    expect(detail.items[0].planIds).toHaveLength(2);
  });

  it('alternativa de un pendiente (DX-417): misma presentación; cuenta desde aceptado, no en lo presentado', async () => {
    const r = await report(a, MONTH.nov25);
    expect(step(r, 'PRESENTED')).toMatchObject({ count: 1, amount: 600 });
    expect(step(r, 'ACCEPTED')).toMatchObject({ count: 1, amount: 300 });
    expect(r.outcomes.rejected.count).toBe(0);
  });

  it('pendiente borrado a mitad de la cadena: se atraviesa y solo suma lo vivo', async () => {
    const r = await report(a, MONTH.jan);
    expect(step(r, 'PRESENTED')).toMatchObject({ count: 1, amount: 400 });
    expect(step(r, 'ACCEPTED')).toMatchObject({ count: 1, amount: 100 });
    const detail = await context.run(a.tenantId, () =>
      useCase.presentations({
        ...MONTH.jan,
        actor: admin(a),
        allowedLocationIds: 'ALL',
        step: 'PRESENTED',
      }),
    );
    // El borrado no se lista.
    expect(detail.items[0].planIds).toHaveLength(2);
  });

  it('ítem borrado de un plan vivo, con cita e imputación: ni suma, ni agenda, ni cobra', async () => {
    const r = await report(a, MONTH.feb);
    expect(step(r, 'PRESENTED')).toMatchObject({ count: 1, amount: 100 });
    expect(step(r, 'ACCEPTED')).toMatchObject({ count: 1, amount: 100 });
    expect(step(r, 'SCHEDULED')).toMatchObject({ count: 0, amount: 0 });
    expect(step(r, 'COLLECTED')).toMatchObject({ count: 0, amount: 0 });
  });

  it('el período es civil en la zona de la sede', async () => {
    expect(step(await report(a, MONTH.apr), 'PRESENTED').count).toBe(1);
    expect(step(await report(a, MONTH.may), 'PRESENTED').count).toBe(1);
  });

  it('el detalle: paginado, por fecha desc, con paciente y sin la nota del rechazo', async () => {
    const page1 = await context.run(a.tenantId, () =>
      useCase.presentations({
        ...MONTH.oct,
        actor: admin(a),
        allowedLocationIds: 'ALL',
        step: 'PRESENTED',
        pageSize: 4,
      }),
    );
    expect(page1).toMatchObject({ total: 10, page: 1, pageSize: 4 });
    expect(page1.items).toHaveLength(4);
    const dates = page1.items.map((i) => i.presentedAt.getTime());
    expect([...dates].sort((x, y) => y - x)).toEqual(dates);
    expect(page1.items[0]).toMatchObject({
      patientId: a.patientId,
      patientName: 'Paciente dx558-a',
      locationId: a.main,
      locationName: 'Sede principal',
      timeZone: 'America/Caracas',
      professionalId: a.dentist.userId,
      professionalName: 'Dra. Reportes',
    });
    expect(JSON.stringify(page1)).not.toContain('Otro motivo');
    const past = await context.run(a.tenantId, () =>
      useCase.presentations({
        ...MONTH.oct,
        actor: admin(a),
        allowedLocationIds: 'ALL',
        step: 'PRESENTED',
        page: 5,
        pageSize: 4,
      }),
    );
    expect(past).toMatchObject({ items: [], total: 10 });
    const collected = await context.run(a.tenantId, () =>
      useCase.presentations({
        ...MONTH.oct,
        actor: admin(a),
        allowedLocationIds: 'ALL',
        step: 'COLLECTED',
      }),
    );
    expect(collected.items).toEqual([
      expect.objectContaining({ acceptedAmount: 300, collectedAmount: 150 }),
    ]);
  });

  it('RLS: otra clínica no se ve (filtros de B con A fijada → nada)', async () => {
    const own = await report(b, MONTH.oct);
    expect(step(own, 'PRESENTED').count).toBe(10);
    // Las sedes de B con la clínica A en contexto: nada.
    const scope = {
      locationIds: [b.main, b.norte],
      includeWithoutLocation: false,
      currency: 'USD',
    };
    const crossed = await context.run(a.tenantId, () =>
      repo.aggregate(MONTH.oct, scope),
    );
    expect(crossed.total.presented).toBe(0);
    // La RLS sola ya aísla: el filtro explícito de B con la clínica A fijada
    // en la transacción → nada.
    const asB = new TenantContextService();
    const crossedRepo = new PrismaQuoteFunnelRepository(prisma, asB);
    const rls = await context.run(a.tenantId, () =>
      asB.run(b.tenantId, () => crossedRepo.aggregate(MONTH.oct, scope)),
    );
    expect(rls.total.presented).toBe(0);
  });
});

describe('Embudo de presupuestos con 20 000 planes en 12 meses (DX-558, int)', () => {
  const context = new TenantContextService();
  const prisma = new PrismaService(context);
  const repo = new PrismaQuoteFunnelRepository(prisma, context);
  const useCase = new GetQuoteFunnelUseCase(
    repo,
    new PrismaCatalogCurrencyReader(prisma, context),
  );
  const YEAR = { from: '2025-11-01', to: '2026-10-31' };
  let c: FunnelClinic;

  const input = (): QuoteFunnelInput => ({
    ...YEAR,
    actor: {
      userId: c.dentist.userId,
      role: ClinicRole.ADMIN,
      permissions: [],
    },
    allowedLocationIds: 'ALL',
  });

  beforeAll(async () => {
    await prisma.onModuleInit();
    c = await clinic('dx558-perf');
    const t = c.tenantId;
    const catalog = await raw.dentalCatalogItem.create({
      data: {
        tenantId: t,
        code: 'RES-PERF',
        kind: 'PROCEDURE',
        labelEs: 'Resina',
        color: '#123456',
      },
    });
    // g % 10: 0-3 aceptados (el 0 en parte: deja un pendiente), 4-5
    // presentados, 6-7 rechazados, 8 la opción A rechazada por aceptar la B
    // (9). Presentados en los 365 días, minuto a minuto distintos.
    const id = (g: string) => `md5('dx558-plan-' || ${g})::uuid`;
    const presentedAt = (g: string) =>
      `(TIMESTAMP '2025-11-01 15:00' + ((${g} % 365) * INTERVAL '1 day') + ((${g} % 600) * INTERVAL '1 minute'))`;
    const accepted = `(g % 10 < 4 OR g % 10 = 9)`;
    await withoutTriggers(async (tx) => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "treatment_plans" ("id", "tenantId", "patientId", "status",
          "currency", "createdById", "createdAt", "updatedAt", "presentedAt",
          "presentedLocationId", "acceptedAt", "rejectedAt", "rejectionReason",
          "optionGroupId")
        SELECT ${id('g')}, '${t}', '${c.patientId}',
               (CASE WHEN ${accepted} THEN 'ACCEPTED'
                     WHEN g % 10 IN (4, 5) THEN 'PRESENTED'
                     ELSE 'REJECTED' END)::"TreatmentPlanStatus",
               'USD',
               (CASE WHEN g % 2 = 0 THEN '${c.dentist.userId}' ELSE '${c.otherDentistId}' END)::uuid,
               ${presentedAt('g')}, now(), ${presentedAt('g')},
               (CASE WHEN g % 3 = 0 THEN '${c.norte}' ELSE '${c.main}' END)::uuid,
               CASE WHEN ${accepted} THEN ${presentedAt('g')} + (g % 7) * INTERVAL '1 day' END,
               CASE WHEN g % 10 IN (6, 7, 8) THEN ${presentedAt('g')} + INTERVAL '3 days' END,
               (CASE WHEN g % 10 = 6 THEN 'PRICE' WHEN g % 10 = 7 THEN 'FEAR'
                     WHEN g % 10 = 8 THEN 'OTHER_OPTION_ACCEPTED' END)::"TreatmentPlanRejectionReason",
               CASE WHEN g % 10 = 8 THEN ${id('g')} WHEN g % 10 = 9 THEN ${id('g - 1')} END
          FROM generate_series(1, 20000) AS g`);
      // La historia de los dos años anteriores (40 000 planes, ya cerrados):
      // no es del período; un período corto no debe crecer con ella.
      await tx.$executeRawUnsafe(`
        INSERT INTO "treatment_plans" ("id", "tenantId", "patientId", "status",
          "currency", "createdById", "createdAt", "updatedAt", "presentedAt",
          "presentedLocationId", "acceptedAt", "optionGroupId")
        SELECT md5('dx558-old-' || g)::uuid, '${t}', '${c.patientId}',
               (CASE WHEN g % 2 = 0 THEN 'COMPLETED' ELSE 'CANCELLED' END)::"TreatmentPlanStatus",
               'USD', '${c.dentist.userId}',
               TIMESTAMP '2023-11-01 15:00' + ((g % 730) * INTERVAL '1 day'), now(),
               TIMESTAMP '2023-11-01 15:00' + ((g % 730) * INTERVAL '1 day'),
               '${c.main}',
               CASE WHEN g % 2 = 0 THEN TIMESTAMP '2023-11-02 15:00' + ((g % 730) * INTERVAL '1 day') END,
               CASE WHEN g % 10 = 9 THEN md5('dx558-old-' || g)::uuid END
          FROM generate_series(1, 40000) AS g`);
      // Pendientes de las aceptaciones parciales (2 000).
      await tx.$executeRawUnsafe(`
        INSERT INTO "treatment_plans" ("id", "tenantId", "patientId", "status",
          "currency", "createdById", "createdAt", "updatedAt", "presentedAt",
          "presentedLocationId", "splitFromPlanId")
        SELECT md5('dx558-pending-' || g)::uuid, p."tenantId", p."patientId",
               'PRESENTED', 'USD', p."createdById", p."createdAt", now(),
               p."presentedAt", p."presentedLocationId", p."id"
          FROM generate_series(10, 20000, 10) AS g
          JOIN "treatment_plans" p ON p."id" = ${id('g')}`);
      // Dos ítems por plan (y uno por pendiente).
      await tx.$executeRawUnsafe(`
        INSERT INTO "treatment_plan_items" ("id", "tenantId", "planId",
          "patientId", "toothNumber", "catalogItemId", "price", "discount",
          "status", "completedAt", "createdAt", "updatedAt")
        SELECT gen_random_uuid(), p."tenantId", p."id", p."patientId",
               (10 + n)::text, '${catalog.id}', 100 + (n * 10), 0,
               (CASE WHEN p."status" = 'ACCEPTED' AND n = 1 AND p."acceptedAt" < now() - INTERVAL '30 days' THEN 'DONE'
                     WHEN p."status" = 'ACCEPTED' THEN 'ACCEPTED'
                     ELSE 'PROPOSED' END)::"TreatmentPlanItemStatus",
               CASE WHEN p."status" = 'ACCEPTED' AND n = 1 AND p."acceptedAt" < now() - INTERVAL '30 days' THEN p."acceptedAt" END,
               now(), now()
          FROM "treatment_plans" p
          CROSS JOIN generate_series(1, 2) AS n
         WHERE p."tenantId" = '${t}'
           AND (p."splitFromPlanId" IS NULL OR n = 1)`);
      // Citas (una por hora: no se solapan) para el 2.º ítem de 1 de cada 3
      // aceptados, e imputaciones de 50 al 1.º de otro tercio.
      await tx.$executeRawUnsafe(`
        INSERT INTO "appointments" ("id", "tenantId", "locationId",
          "patientId", "providerId", "start", "end", "status", "createdAt",
          "updatedAt")
        SELECT md5('dx558-appt-' || i."id")::uuid, i."tenantId", '${c.main}',
               i."patientId", '${c.dentist.userId}',
               TIMESTAMP '2025-11-01 12:00' + row_number() OVER (ORDER BY i."id") * INTERVAL '1 hour',
               TIMESTAMP '2025-11-01 12:30' + row_number() OVER (ORDER BY i."id") * INTERVAL '1 hour',
               'SCHEDULED', now(), now()
          FROM "treatment_plan_items" i
         WHERE i."tenantId" = '${t}' AND i."status" = 'ACCEPTED'
           AND i."toothNumber" = '12' AND get_byte(decode(md5(i."id"::text), 'hex'), 0) % 3 = 0`);
      await tx.$executeRawUnsafe(`
        INSERT INTO "appointment_plan_items" ("tenantId", "patientId",
          "appointmentId", "planItemId", "createdAt")
        SELECT i."tenantId", i."patientId", md5('dx558-appt-' || i."id")::uuid,
               i."id", now()
          FROM "treatment_plan_items" i
         WHERE i."tenantId" = '${t}' AND i."status" = 'ACCEPTED'
           AND i."toothNumber" = '12' AND get_byte(decode(md5(i."id"::text), 'hex'), 0) % 3 = 0`);
      await tx.$executeRawUnsafe(`
        INSERT INTO "payment_allocations" ("id", "tenantId", "paymentId",
          "treatmentPlanId", "treatmentPlanItemId", "amount", "source",
          "createdAt", "updatedAt")
        SELECT gen_random_uuid(), i."tenantId", gen_random_uuid(), i."planId",
               i."id", 50, 'AUTO', now(), now()
          FROM "treatment_plan_items" i
         WHERE i."tenantId" = '${t}' AND i."status" IN ('ACCEPTED', 'DONE')
           AND i."toothNumber" = '11' AND get_byte(decode(md5(i."id"::text), 'hex'), 0) % 3 = 1`);
    });
    for (const table of [
      'treatment_plans',
      'treatment_plan_items',
      'appointments',
      'appointment_plan_items',
      'payment_allocations',
    ]) {
      await raw.$executeRawUnsafe(`ANALYZE "${table}"`);
    }
  }, 300_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await prisma.onModuleDestroy();
    await raw.$disconnect();
  });

  async function best<T>(
    run: () => Promise<T>,
  ): Promise<{ ms: number[]; result: T }> {
    // La primera llamada abre las conexiones del pool: no es lo que se mide.
    let result = await run();
    const ms: number[] = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      result = await run();
      ms.push(performance.now() - started);
    }
    return { ms, result };
  }

  it('el embudo de 12 meses sale en menos de 500 ms como dentalix_app', async () => {
    const { ms, result } = await best(() =>
      context.run(c.tenantId, () => useCase.execute(input())),
    );
    // 20 000 planes raíz; las parejas A/B (8 y 9) son una presentación.
    expect(step(result, 'PRESENTED').count).toBe(18_000);
    expect(step(result, 'ACCEPTED').count).toBe(10_000);
    expect(result.outcomes.pending.count).toBe(4_000);
    expect(result.outcomes.rejected.count).toBe(4_000);
    expect(result.rejectionReasons.map((r) => r.count)).toEqual([2_000, 2_000]);
    expect(result.byProfessional).toHaveLength(2);
    console.info(
      `DX-558 · embudo, 20 000 planes, 12 meses: ${ms.map((v) => v.toFixed(0)).join(' / ')} ms`,
    );
    expect(Math.min(...ms)).toBeLessThan(500);
  }, 120_000);

  it('la 1.ª página del detalle sale en menos de 500 ms como dentalix_app', async () => {
    const { ms, result } = await best(() =>
      context.run(c.tenantId, () =>
        useCase.presentations({ ...input(), step: 'ACCEPTED' }),
      ),
    );
    expect(result.total).toBe(10_000);
    expect(result.items).toHaveLength(25);
    console.info(
      `DX-558 · detalle (1.ª página), 20 000 planes, 12 meses: ${ms.map((v) => v.toFixed(0)).join(' / ')} ms`,
    );
    expect(Math.min(...ms)).toBeLessThan(500);
  }, 120_000);

  it('un mes no recorre treatment_plans entero: usa el índice de presentaciones', async () => {
    // Con 12 meses sobre una clínica de 12 meses, leer la tabla entera ES lo
    // barato (y el planificador lo elige); lo que se vigila es que un período
    // corto no crezca con la historia.
    // Captura la consulta del agregado tal como la manda el repositorio.
    const captured: Prisma.Sql[] = [];
    const original = prisma.runWithTenant.bind(prisma) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const spy = jest
      .spyOn(prisma, 'runWithTenant')
      .mockImplementation((...args: unknown[]) => {
        const at = typeof args[0] === 'function' ? 0 : 1;
        const fn = args[at] as (tx: Prisma.TransactionClient) => unknown;
        args[at] = (tx: Prisma.TransactionClient) =>
          fn(
            new Proxy(tx, {
              get(target, prop, receiver) {
                if (prop !== '$queryRaw') {
                  return Reflect.get(target, prop, receiver) as unknown;
                }
                return (query: TemplateStringsArray, ...values: unknown[]) => {
                  const sql = Prisma.sql(query, ...values);
                  if (sql.sql.includes('"funnel" AS')) captured.push(sql);
                  return target.$queryRaw(sql);
                };
              },
            }),
          );
        return original(...args);
      });
    try {
      await context.run(c.tenantId, () =>
        useCase.execute({ ...input(), from: '2026-10-01', to: '2026-10-31' }),
      );
    } finally {
      spy.mockRestore();
    }
    expect(captured).toHaveLength(1);
    const plan = await prisma.runWithTenant(c.tenantId, (tx) =>
      tx.$queryRaw<{ 'QUERY PLAN': string }[]>(
        Prisma.sql`EXPLAIN ${captured[0]}`,
      ),
    );
    const text = plan.map((row) => row['QUERY PLAN']).join('\n');
    expect(text).toMatch(/treatment_plans_tenant_presented_idx/);
    expect(text).not.toMatch(/Seq Scan on treatment_plans/);
  });
});
