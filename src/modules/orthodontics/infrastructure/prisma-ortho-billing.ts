import { Prisma, type OrthoTechnique } from '@prisma/client';
import { fromCents, toCents } from '../../../shared/money/money';
import { requireLocationTimeZone } from '../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../shared/time/civil-day';
import {
  alignerStatus,
  plannedCharges,
  type ChargeFacts,
  type OrthoFeeSplit,
} from '../domain/ortho-billing';
import type {
  OrthoAccountPaymentPlan,
  OrthoAlignerSeriesView,
  OrthoBalanceFlag,
} from '../domain/entities';
import type {
  AddAlignerDeliveryInput,
  AddAlignerDeliveryOutcome,
  AcceptOrthoFeeInput,
  AcceptOrthoFeeOutcome,
  OrthoAccountFacts,
} from '../domain/ports/ortho-repository.port';

// SQL del cobro de ortodoncia (DX-285). Todo corre dentro de una transacción
// con el tenant fijado (RLS FORCE) y, además, filtra por "tenantId" para que
// cada consulta use sus índices.

/** Plan que abre el honorario cuando el caso no tiene plan ligado. */
export const ORTHO_PLAN_NOTES =
  'Honorario del caso de ortodoncia: cuota inicial, un ítem por control y retiro.';

/** Procedimiento del catálogo de cada cargo (códigos del catálogo de fábrica). */
function catalogFor(
  kind: 'INITIAL' | 'VISIT' | 'RETENTION',
  technique: OrthoTechnique,
): { code: string; label: string } {
  if (kind === 'VISIT') {
    return { code: 'ORTO-CONTROL', label: 'Control / ajuste mensual' };
  }
  if (kind === 'RETENTION') {
    return { code: 'ORTO-RETENEDOR', label: 'Retenedores' };
  }
  if (technique === 'ALIGNERS') {
    return { code: 'ORTO-ALINEADORES', label: 'Ortodoncia con alineadores' };
  }
  if (technique === 'AESTHETIC_BRACKETS') {
    return {
      code: 'ORTO-BRACKETS-EST',
      label: 'Ortodoncia con brackets estéticos',
    };
  }
  return {
    code: 'ORTO-BRACKETS-MET',
    label: 'Ortodoncia con brackets metálicos',
  };
}

/**
 * El procedimiento vivo del catálogo con ese código; si la clínica no lo tiene
 * (lo borró o su catálogo no es el de fábrica), se crea INACTIVO (no sale en
 * los selectores), como el del cargo por inasistencia. ON CONFLICT sobre el
 * único parcial de los vivos: dos aceptaciones a la vez lo crean una vez.
 */
async function catalogItemId(
  tx: Prisma.TransactionClient,
  tenantId: string,
  entry: { code: string; label: string },
): Promise<string> {
  const found = await tx.dentalCatalogItem.findFirst({
    where: { code: entry.code, deletedAt: null },
    select: { id: true },
  });
  if (found) return found.id;
  await tx.$executeRaw`
    INSERT INTO "dental_catalog_items"
      ("id", "tenantId", "code", "category", "kind", "labelEs", "color",
       "allowDiscount", "active", "createdAt", "updatedAt")
    VALUES (gen_random_uuid(), ${tenantId}::uuid, ${entry.code},
            'Ortodoncia', 'PROCEDURE', ${entry.label}, '#9333EA',
            true, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("tenantId", "code") WHERE "deletedAt" IS NULL DO NOTHING`;
  const item = await tx.dentalCatalogItem.findFirstOrThrow({
    where: { code: entry.code, deletedAt: null },
    select: { id: true },
  });
  return item.id;
}

/** Membresía viva del usuario en esta clínica (atribución DX-050), o null. */
async function membershipOf(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<string | null> {
  const m = await tx.clinicMembership.findFirst({
    where: { userId, deletedAt: null },
    select: { id: true },
  });
  return m?.id ?? null;
}

/** El ítem pasa a hecho con su autor y su sede (DX-050), hora del servidor. */
async function markItemDone(
  tx: Prisma.TransactionClient,
  input: { itemId: string; authorId: string; locationId: string },
): Promise<void> {
  const membershipId = await membershipOf(tx, input.authorId);
  await tx.treatmentPlanItem.updateMany({
    where: { id: input.itemId, deletedAt: null, status: { not: 'DONE' } },
    data: {
      status: 'DONE',
      completedAt: new Date(),
      performedLocationId: input.locationId,
      performedById: membershipId ? input.authorId : null,
      performedByMembershipId: membershipId,
    },
  });
}

interface LockedCase {
  id: string;
  patientId: string;
  locationId: string;
  status: string;
  treatmentPlanId: string | null;
  feeCurrency: string | null;
  feeTotal: Prisma.Decimal | null;
  feeInitial: Prisma.Decimal | null;
  feePerVisit: Prisma.Decimal | null;
  feeVisitCount: number | null;
  feeRetention: Prisma.Decimal | null;
  feeAcceptedAt: Date | null;
}

async function lockCase(
  tx: Prisma.TransactionClient,
  tenantId: string,
  caseId: string,
  patientId?: string,
): Promise<LockedCase | null> {
  const [row] = await tx.$queryRaw<LockedCase[]>`
    SELECT "id", "patientId", "locationId", "status"::text AS "status",
           "treatmentPlanId", "feeCurrency", "feeTotal", "feeInitial",
           "feePerVisit", "feeVisitCount", "feeRetention", "feeAcceptedAt"
      FROM "ortho_cases"
     WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${caseId}::uuid
       ${patientId ? Prisma.sql`AND "patientId" = ${patientId}::uuid` : Prisma.empty}
     FOR UPDATE`;
  return row ?? null;
}

const cents = (d: Prisma.Decimal | null): number =>
  d === null ? 0 : toCents(d.toNumber());

/**
 * Acepta el honorario (ver el puerto). El caso queda bloqueado (FOR UPDATE):
 * una aceptación a la vez, y un control que se registra mientras espera y
 * luego ve los cargos.
 */
export async function acceptFeeIn(
  tx: Prisma.TransactionClient,
  tenantId: string,
  input: AcceptOrthoFeeInput,
): Promise<AcceptOrthoFeeOutcome> {
  const c = await lockCase(tx, tenantId, input.caseId, input.patientId);
  if (!c) return { outcome: 'NOT_FOUND' };
  if (c.status === 'FINISHED' || c.status === 'ABANDONED') {
    return { outcome: 'CLOSED' };
  }
  if (c.feeAcceptedAt) return { outcome: 'ALREADY_ACCEPTED' };
  if (c.feeTotal === null || c.feeCurrency === null) {
    return { outcome: 'NO_FEE' };
  }
  const split: OrthoFeeSplit = {
    totalCents: cents(c.feeTotal),
    initialCents: cents(c.feeInitial),
    perVisitCents: cents(c.feePerVisit),
    visitCount: c.feeVisitCount ?? 0,
    retentionCents: cents(c.feeRetention),
  };
  const now = new Date();

  let planId = c.treatmentPlanId;
  let paymentPlanId: string | null = null;
  if (planId) {
    const [plan] = await tx.$queryRaw<
      { status: string; currency: string; signed: boolean }[]
    >`SELECT p."status"::text AS "status", p."currency",
             EXISTS (SELECT 1 FROM "treatment_plan_acceptances" a
                      WHERE a."tenantId" = p."tenantId" AND a."planId" = p."id") AS "signed"
        FROM "treatment_plans" p
       WHERE p."tenantId" = ${tenantId}::uuid AND p."id" = ${planId}::uuid
         AND p."deletedAt" IS NULL
       FOR SHARE`;
    if (!plan || ['REJECTED', 'CANCELLED', 'COMPLETED'].includes(plan.status)) {
      return { outcome: 'PLAN_CLOSED' };
    }
    if (plan.currency !== c.feeCurrency) return { outcome: 'PLAN_CURRENCY' };
    const active = await tx.paymentPlan.findFirst({
      where: { treatmentPlanId: planId, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    if (active) {
      // Las cuotas ya cobran el tratamiento: no se duplica el cargo.
      paymentPlanId = active.id;
    } else {
      if (plan.status !== 'ACCEPTED') return { outcome: 'PLAN_NOT_ACCEPTED' };
      if (plan.signed) return { outcome: 'PLAN_SIGNED' };
    }
  } else {
    const created = await tx.treatmentPlan.create({
      data: {
        tenantId,
        patientId: c.patientId,
        status: 'ACCEPTED',
        currency: c.feeCurrency,
        acceptedAt: now,
        acceptedLocationId: c.locationId,
        notes: ORTHO_PLAN_NOTES,
        createdById: input.actorId,
      },
      select: { id: true },
    });
    planId = created.id;
  }

  let chargesCreated = 0;
  if (!paymentPlanId) {
    const planned = plannedCharges(split);
    const catalog = new Map<string, string>();
    for (const kind of ['INITIAL', 'VISIT', 'RETENTION'] as const) {
      if (planned.some((p) => p.kind === kind)) {
        catalog.set(
          kind,
          await catalogItemId(tx, tenantId, catalogFor(kind, input.technique)),
        );
      }
    }
    for (const p of planned) {
      const item = await tx.treatmentPlanItem.create({
        data: {
          tenantId,
          planId,
          toothNumber: '',
          surfaces: [],
          catalogItemId: catalog.get(p.kind)!,
          price: fromCents(p.priceCents),
          status: 'ACCEPTED',
          notes: p.note,
          pricingLocationId: c.locationId,
          createdById: input.actorId,
        },
        select: { id: true },
      });
      await tx.orthoCaseCharge.create({
        data: {
          tenantId,
          caseId: c.id,
          kind: p.kind,
          sequence: p.sequence,
          planId,
          planItemId: item.id,
        },
      });
      chargesCreated += 1;
    }
    // La inicial se cobra al aceptar (cementado o entrega de alineadores).
    const initial = await tx.orthoCaseCharge.findFirst({
      where: { caseId: c.id, kind: 'INITIAL' },
      select: { planItemId: true },
    });
    if (initial) {
      await markItemDone(tx, {
        itemId: initial.planItemId,
        authorId: input.actorId,
        locationId: c.locationId,
      });
    }
    // Los controles ya registrados realizan sus cargos, en orden.
    const visits = await tx.orthoVisit.findMany({
      where: { caseId: c.id, patientId: c.patientId },
      orderBy: [{ visitDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, authorId: true },
    });
    for (const v of visits) {
      await realizeVisitChargeIn(tx, tenantId, {
        caseId: c.id,
        visitId: v.id,
        authorId: v.authorId,
        locationId: c.locationId,
      });
    }
    // Retiro: si el caso ya está en retención.
    if (c.status === 'RETENTION') {
      await realizeRetentionIn(tx, tenantId, {
        caseId: c.id,
        authorId: input.actorId,
        locationId: c.locationId,
      });
    }
  }

  await tx.orthoCase.update({
    where: { id: c.id },
    data: {
      treatmentPlanId: planId,
      feeAcceptedAt: now,
      feeAcceptedById: input.actorId,
      feePaymentPlanId: paymentPlanId,
    },
  });
  return { outcome: 'OK', planId, chargesCreated, paymentPlanId };
}

/**
 * El control `visitId` realiza el cargo del siguiente control sin realizar
 * (el de menor n.º). Sin cargos (honorario sin aceptar, con cuotas o más
 * controles que los cobrables), nada. El único por "visitId" impide que un
 * control cobre dos veces.
 */
export async function realizeVisitChargeIn(
  tx: Prisma.TransactionClient,
  tenantId: string,
  input: {
    caseId: string;
    visitId: string;
    authorId: string;
    locationId?: string;
  },
): Promise<void> {
  const [next] = await tx.$queryRaw<{ id: string; planItemId: string }[]>`
    SELECT ch."id", ch."planItemId"
      FROM "ortho_case_charges" ch
      JOIN "treatment_plan_items" i
        ON i."tenantId" = ch."tenantId" AND i."id" = ch."planItemId"
     WHERE ch."tenantId" = ${tenantId}::uuid AND ch."caseId" = ${input.caseId}::uuid
       AND ch."kind" = 'VISIT' AND ch."visitId" IS NULL
       AND i."deletedAt" IS NULL
     ORDER BY ch."sequence"
     LIMIT 1
     FOR UPDATE OF ch`;
  if (!next) return;
  const already = await tx.orthoCaseCharge.findFirst({
    where: { visitId: input.visitId },
    select: { id: true },
  });
  if (already) return;
  await tx.orthoCaseCharge.update({
    where: { id: next.id },
    data: { visitId: input.visitId },
  });
  const locationId =
    input.locationId ??
    (
      await tx.orthoCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: { locationId: true },
      })
    ).locationId;
  await markItemDone(tx, {
    itemId: next.planItemId,
    authorId: input.authorId,
    locationId,
  });
}

/** Al pasar a retención o finalizar, el retiro pasa a hecho. */
export async function realizeRetentionIn(
  tx: Prisma.TransactionClient,
  tenantId: string,
  input: { caseId: string; authorId: string; locationId: string },
): Promise<void> {
  const charge = await tx.orthoCaseCharge.findFirst({
    where: { tenantId, caseId: input.caseId, kind: 'RETENTION' },
    select: { planItemId: true },
  });
  if (!charge) return;
  await markItemDone(tx, {
    itemId: charge.planItemId,
    authorId: input.authorId,
    locationId: input.locationId,
  });
}

interface ChargeRow {
  kind: ChargeFacts['kind'];
  sequence: number;
  billable: Prisma.Decimal;
  paid: Prisma.Decimal;
  status: string;
  removed: boolean;
  completedAt: Date | null;
}

/** Hechos de la cuenta de un caso en UNA foto (RepeatableRead). */
export async function accountFactsIn(
  tx: Prisma.TransactionClient,
  tenantId: string,
  input: { patientId: string; caseId: string; now: Date },
): Promise<OrthoAccountFacts | null> {
  const found = await tx.orthoCase.findFirst({
    where: { id: input.caseId, patientId: input.patientId },
    select: {
      id: true,
      feePaymentPlanId: true,
      location: { select: { id: true, timeZone: true } },
    },
  });
  if (!found) return null;
  const zone = requireLocationTimeZone(found.location);
  const rows = await tx.$queryRaw<ChargeRow[]>`
    SELECT ch."kind", ch."sequence"::int AS "sequence",
           (i."price" - i."discount") AS "billable",
           coalesce((
             SELECT sum(a."amount")
               FROM "payment_allocations" a
              WHERE a."tenantId" = i."tenantId" AND a."treatmentPlanItemId" = i."id"
           ), 0)::numeric AS "paid",
           i."status"::text AS "status",
           (i."deletedAt" IS NOT NULL OR p."deletedAt" IS NOT NULL
            OR p."status" IN ('REJECTED', 'CANCELLED')) AS "removed",
           i."completedAt"
      FROM "ortho_case_charges" ch
      JOIN "treatment_plan_items" i
        ON i."tenantId" = ch."tenantId" AND i."id" = ch."planItemId"
      JOIN "treatment_plans" p
        ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
     WHERE ch."tenantId" = ${tenantId}::uuid AND ch."caseId" = ${input.caseId}::uuid
     ORDER BY ch."kind", ch."sequence"`;
  const visitsDone = await tx.orthoVisit.count({
    where: { caseId: input.caseId, patientId: input.patientId },
  });
  let paymentPlan: OrthoAccountPaymentPlan | null = null;
  if (found.feePaymentPlanId) {
    const pp = await tx.paymentPlan.findFirst({
      where: { id: found.feePaymentPlanId },
      select: {
        id: true,
        status: true,
        installmentsCount: true,
        totalToFinance: true,
        currency: true,
      },
    });
    if (pp) {
      paymentPlan = {
        id: pp.id,
        status: pp.status,
        installmentsCount: pp.installmentsCount,
        totalToFinance: pp.totalToFinance.toNumber(),
        currency: pp.currency,
      };
    }
  }
  return {
    today: civilDateIn(input.now, zone),
    visitsDone,
    paymentPlan,
    charges: rows.map((r) => ({
      kind: r.kind,
      sequence: r.sequence,
      billableCents: cents(r.billable),
      paidCents: cents(r.paid),
      done: r.status === 'DONE',
      removed: r.removed,
      realizedOn:
        r.status === 'DONE' && r.completedAt
          ? civilDateIn(r.completedAt, zone)
          : null,
    })),
  };
}

/**
 * «Ortodoncia: saldo vencido» de un lote de pacientes en UNA consulta: algún
 * cargo de sus casos hecho hace MÁS de `orthoOverdueDays` días (día civil de
 * la sede del caso) y no cubierto por lo imputado. Los casos aceptados con
 * cuotas no marcan (manda el calendario de cuotas y su chip de siempre).
 */
export async function overdueFlagsIn(
  tx: Prisma.TransactionClient,
  tenantId: string,
  patientIds: readonly string[],
  now: Date,
): Promise<Map<string, OrthoBalanceFlag>> {
  const out = new Map<string, OrthoBalanceFlag>();
  const ids = [...new Set(patientIds)];
  if (ids.length === 0) return out;
  const rows = await tx.$queryRaw<{ patientId: string; days: number }[]>`
    WITH t AS MATERIALIZED (
      SELECT "orthoOverdueDays" AS "n" FROM "tenants" WHERE "id" = ${tenantId}::uuid
    ),
    c AS MATERIALIZED (
      SELECT oc."id", oc."patientId", coalesce(l."timeZone", 'UTC') AS "zone"
        FROM "ortho_cases" oc
        JOIN "locations" l ON l."tenantId" = oc."tenantId" AND l."id" = oc."locationId"
       WHERE oc."tenantId" = ${tenantId}::uuid
         AND oc."patientId" = ANY(${ids}::uuid[])
         AND oc."feeAcceptedAt" IS NOT NULL
         AND oc."feePaymentPlanId" IS NULL
    ),
    d AS (
      SELECT c."patientId",
             ((${now}::timestamptz AT TIME ZONE c."zone")::date
               - ((i."completedAt" AT TIME ZONE 'UTC') AT TIME ZONE c."zone")::date) AS "days"
        FROM c
        JOIN "ortho_case_charges" ch
          ON ch."tenantId" = ${tenantId}::uuid AND ch."caseId" = c."id"
        JOIN "treatment_plan_items" i
          ON i."tenantId" = ch."tenantId" AND i."id" = ch."planItemId"
        JOIN "treatment_plans" p
          ON p."tenantId" = i."tenantId" AND p."id" = i."planId"
       WHERE i."status" = 'DONE' AND i."deletedAt" IS NULL
         AND i."completedAt" IS NOT NULL
         AND p."deletedAt" IS NULL AND p."status" NOT IN ('REJECTED', 'CANCELLED')
         AND (i."price" - i."discount") > coalesce((
               SELECT sum(a."amount") FROM "payment_allocations" a
                WHERE a."tenantId" = i."tenantId" AND a."treatmentPlanItemId" = i."id"
             ), 0)
    )
    SELECT d."patientId", max(d."days")::int AS "days"
      FROM d, t
     WHERE d."days" > t."n"
     GROUP BY d."patientId"`;
  for (const r of rows) {
    out.set(r.patientId, { hasOverdue: true, overdueDays: r.days });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Alineadores
// ---------------------------------------------------------------------------

export interface AlignerSeriesRow {
  id: string;
  caseId: string;
  arch: OrthoAlignerSeriesView['arch'];
  brand: string;
  totalTrays: number;
  daysPerTray: number;
  refinementOfId: string | null;
  createdById: string;
  createdAt: Date;
  deliveries: {
    id: string;
    fromTray: number;
    toTray: number;
    deliveredOn: Date;
    visitId: string | null;
    createdById: string;
    createdAt: Date;
  }[];
}

const isoDay = (value: Date): string => value.toISOString().slice(0, 10);

/** Las series del caso con sus entregas y su bandeja actual, por antigüedad. */
export function alignerSeriesViews(
  rows: readonly AlignerSeriesRow[],
  names: ReadonlyMap<string, string>,
  today: string,
): OrthoAlignerSeriesView[] {
  const sequenceOf = new Map<string, number>();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seq = (id: string, depth = 0): number => {
    const known = sequenceOf.get(id);
    if (known !== undefined) return known;
    const row = byId.get(id);
    const parent = row?.refinementOfId;
    const value = parent && depth < 100 ? seq(parent, depth + 1) + 1 : 1;
    sequenceOf.set(id, value);
    return value;
  };
  return rows.map((r) => {
    const deliveries = [...r.deliveries]
      .sort((a, b) => a.fromTray - b.fromTray)
      .map((d) => ({
        id: d.id,
        fromTray: d.fromTray,
        toTray: d.toTray,
        deliveredOn: isoDay(d.deliveredOn),
        visitId: d.visitId,
        createdById: d.createdById,
        createdByName: names.get(d.createdById) ?? null,
        createdAt: d.createdAt,
      }));
    return {
      id: r.id,
      caseId: r.caseId,
      arch: r.arch,
      brand: r.brand,
      totalTrays: r.totalTrays,
      daysPerTray: r.daysPerTray,
      refinementOfId: r.refinementOfId,
      sequence: seq(r.id),
      createdById: r.createdById,
      createdByName: names.get(r.createdById) ?? null,
      createdAt: r.createdAt,
      deliveries,
      ...alignerStatus(r, deliveries, today),
    };
  });
}

export async function addAlignerDeliveryIn(
  tx: Prisma.TransactionClient,
  tenantId: string,
  input: AddAlignerDeliveryInput,
): Promise<AddAlignerDeliveryOutcome> {
  // El caso bloqueado: dos entregas de la misma serie a la vez no se cruzan.
  const c = await lockCase(tx, tenantId, input.caseId);
  if (!c) return { outcome: 'SERIES_NOT_FOUND' };
  if (c.status === 'FINISHED' || c.status === 'ABANDONED') {
    return { outcome: 'CASE_CLOSED' };
  }
  const series = await tx.orthoAlignerSeries.findFirst({
    where: { id: input.seriesId, caseId: input.caseId },
    select: {
      totalTrays: true,
      deliveries: {
        select: { fromTray: true, toTray: true, deliveredOn: true },
      },
    },
  });
  if (!series) return { outcome: 'SERIES_NOT_FOUND' };
  const checked = input.validate(
    { totalTrays: series.totalTrays },
    series.deliveries.map((d) => ({
      fromTray: d.fromTray,
      toTray: d.toTray,
      deliveredOn: isoDay(d.deliveredOn),
    })),
  );
  if (!checked.ok) return { outcome: 'INVALID', message: checked.message };
  const row = await tx.orthoAlignerDelivery.create({
    data: {
      tenantId,
      caseId: input.caseId,
      seriesId: input.seriesId,
      fromTray: checked.value.fromTray,
      toTray: checked.value.toTray,
      deliveredOn: new Date(`${checked.value.deliveredOn}T00:00:00.000Z`),
      visitId: input.visitId,
      createdById: input.createdById,
    },
    select: { id: true },
  });
  return { outcome: 'OK', id: row.id };
}
