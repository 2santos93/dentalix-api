import { Injectable } from '@nestjs/common';
import { PaymentPlanStatus, Prisma, TreatmentPlanStatus } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  loadLocationTimeZones,
  resolveLocationTimeZones,
} from '../../../shared/locations/location-time-zone';
import type {
  DebtorDetails,
  PatientLedger,
} from '../domain/entities/receivables.entity';
import type {
  LedgersQuery,
  ReceivablesLocation,
  ReceivablesRepository,
} from '../domain/ports/receivables-repository.port';

interface PlanSqlRow {
  patientId: string;
  locationId: string | null;
  id: string;
  status: TreatmentPlanStatus;
  currency: string;
  createdAt: Date;
  agingFrom: Date;
  billable: number;
  /** Abonos vivos del plan en SU moneda, sumados; `null` si no hay. */
  paidOwn: number | null;
  /** Abonos vivos del plan en OTRA moneda, sueltos; `null` si no hay. */
  paidOther: { currency: string; amount: number }[] | null;
}

interface PaymentPlanSqlRow {
  id: string;
  patientId: string;
  treatmentPlanId: string;
  currency: string;
  status: PaymentPlanStatus;
  downPayment: number;
  startDate: Date;
  installments: { sequence: number; dueMs: number; amount: number }[];
}

interface DebtorSqlRow {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  countryCode: string | null;
  paidAt: Date | null;
  amount: number | null;
  currency: string | null;
  paymentLocationId: string | null;
}

function groupBy<T extends { patientId: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.patientId);
    if (list) list.push(row);
    else out.set(row.patientId, [row]);
  }
  return out;
}

/**
 * Lecturas de la cartera (DX-145). Todo con `runWithTenant` (RLS por
 * `app.current_tenant`) Y con `"tenantId"` explícito en cada consulta, como el
 * resto de repositorios. Importes como `float8`: Decimal(14,2) cabe exacto en
 * un double y el cálculo redondea a centavos.
 */
@Injectable()
export class PrismaReceivablesRepository implements ReceivablesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async findLocation(locationId: string): Promise<ReceivablesLocation | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const location = await tx.location.findFirst({
        where: { id: locationId, tenantId, deletedAt: null },
        select: { id: true, name: true },
      });
      if (!location) return null;
      const zoneOf = await resolveLocationTimeZones(tx, tenantId, [
        location.id,
      ]);
      return { ...location, timeZone: zoneOf(location.id) };
    });
  }

  locationTimeZones(): Promise<Map<string, string>> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant((tx) =>
      loadLocationTimeZones(tx, tenantId),
    );
  }

  /**
   * DOS consultas fijas, sin importar cuántos pacientes, planes o cuotas:
   *
   * 1. Planes de los DEUDORES de la sede, con su sede, facturable y abonos:
   *    - `billable`: Σ precio − Σ descuento de los ítems vivos ACCEPTED|DONE
   *      (el facturable del estado de cuenta) de cada plan vivo;
   *    - `paidOwn`: abonos vivos del plan en su moneda, sumados; `paidOther`:
   *      los de otra moneda, sueltos (raros; `computeBalances` los suma);
   *    - `agingFrom`: aceptación firmada, presentación o creación del plan;
   *    - DEUDOR = paciente vivo con algún plan vivo cuyo facturable supera lo
   *      abonado en la moneda del plan. Es un SUPERCONJUNTO exacto de quien
   *      tiene deuda en `computeBalances` (la deuda sale solo de planes con
   *      saldo > 0, y el saldo a favor nunca la compensa), así que no decide
   *      nada: solo evita traer a quien lo tiene todo pagado. El cálculo
   *      (estados que cuentan, cuotas, monedas) sigue siendo el del estado de
   *      cuenta, en la aplicación. Que el paciente siga vivo se mira solo en
   *      los deudores, no en todos los planes;
   *    - SEDE DE LA DEUDA: la de su última cita ATENDIDA (COMPLETED, viva),
   *      sacada de UNA pasada ordenada por el índice parcial
   *      appointments_tenant_patient_completed_idx (DISTINCT ON, Index Only
   *      Scan; más barato que una búsqueda por deudor, docs/perf/DX-145.md);
   *      si nunca fue atendido, la de su último abono vivo; si tampoco, la de
   *      la última presentación de un plan. Sin ninguna, `null`: solo sale en
   *      la vista consolidada. Se filtra por la sede pedida.
   * 2. Los planes de pago vivos no cancelados de esos pacientes, con sus
   *    cuotas en un json_agg.
   *
   * REPEATABLE READ: las dos ven la misma foto aunque entre un abono.
   */
  async loadLedgers(query: LedgersQuery): Promise<PatientLedger[]> {
    const tenantId = this.tenantId();
    const locationFilter = query.locationId
      ? Prisma.sql`WHERE l."locationId" = ${query.locationId}::uuid`
      : Prisma.empty;

    return this.prisma.runWithTenant(
      async (tx) => {
        const plans = await tx.$queryRaw<PlanSqlRow[]>`
          WITH billable AS (
            SELECT i."planId",
                   (sum(i."price") - sum(i."discount"))::float8 AS "billable"
              FROM "treatment_plan_items" i
             WHERE i."tenantId" = ${tenantId}::uuid
               AND i."deletedAt" IS NULL
               AND i."status" IN ('ACCEPTED', 'DONE')
             GROUP BY i."planId"
          ), paid AS (
            SELECT p."treatmentPlanId",
                   (sum(p."amount") FILTER (WHERE p."currency" = tp."currency"))::float8
                     AS "own",
                   json_agg(json_build_object(
                     'currency', p."currency", 'amount', p."amount"::float8))
                     FILTER (WHERE p."currency" <> tp."currency") AS "other"
              FROM "payments" p
              JOIN "treatment_plans" tp
                ON tp."tenantId" = p."tenantId" AND tp."id" = p."treatmentPlanId"
             WHERE p."tenantId" = ${tenantId}::uuid
               AND p."deletedAt" IS NULL
             GROUP BY p."treatmentPlanId"
          ), plans AS MATERIALIZED (
            SELECT tp."id", tp."patientId", tp."status", tp."currency",
                   tp."createdAt", tp."presentedAt",
                   coalesce(b."billable", 0) AS "billable",
                   pd."own" AS "paidOwn", pd."other" AS "paidOther"
              FROM "treatment_plans" tp
              LEFT JOIN billable b ON b."planId" = tp."id"
              LEFT JOIN paid pd ON pd."treatmentPlanId" = tp."id"
             WHERE tp."tenantId" = ${tenantId}::uuid
               AND tp."deletedAt" IS NULL
          ), last_visit AS (
            SELECT DISTINCT ON (a."patientId") a."patientId", a."locationId"
              FROM "appointments" a
             WHERE a."tenantId" = ${tenantId}::uuid
               AND a."status" = 'COMPLETED'
               AND a."deletedAt" IS NULL
             ORDER BY a."patientId", a."start" DESC, a."id" DESC
          ), located AS MATERIALIZED (
            SELECT d."patientId",
                   coalesce(
                     lv."locationId",
                     (SELECT p."locationId" FROM "payments" p
                       WHERE p."tenantId" = ${tenantId}::uuid
                         AND p."patientId" = d."patientId"
                         AND p."deletedAt" IS NULL
                       ORDER BY p."paidAt" DESC, p."id" DESC
                       LIMIT 1),
                     (SELECT tp."presentedLocationId" FROM "treatment_plans" tp
                       WHERE tp."tenantId" = ${tenantId}::uuid
                         AND tp."patientId" = d."patientId"
                         AND tp."deletedAt" IS NULL
                         AND tp."presentedLocationId" IS NOT NULL
                       ORDER BY tp."presentedAt" DESC NULLS LAST, tp."id" DESC
                       LIMIT 1)
                   ) AS "locationId"
              FROM (SELECT DISTINCT pl."patientId" FROM plans pl
                     WHERE pl."billable" > coalesce(pl."paidOwn", 0)) d
              JOIN "patients" pa
                ON pa."tenantId" = ${tenantId}::uuid
               AND pa."id" = d."patientId"
               AND pa."deletedAt" IS NULL
              LEFT JOIN last_visit lv ON lv."patientId" = d."patientId"
          )
          SELECT l."patientId", l."locationId", pl."id",
                 pl."status"::text AS "status", pl."currency", pl."createdAt",
                 coalesce(acc."acceptedAt", pl."presentedAt", pl."createdAt")
                   AS "agingFrom",
                 pl."billable", pl."paidOwn", pl."paidOther"
            FROM located l
            JOIN plans pl ON pl."patientId" = l."patientId"
            LEFT JOIN "treatment_plan_acceptances" acc
              ON acc."tenantId" = ${tenantId}::uuid AND acc."planId" = pl."id"
          ${locationFilter}`;
        if (plans.length === 0) return [];
        const ids = [...new Set(plans.map((p) => p.patientId))];

        const paymentPlans = await tx.$queryRaw<PaymentPlanSqlRow[]>`
          SELECT pp."id", pp."patientId", pp."treatmentPlanId", pp."currency",
                 pp."status"::text AS "status",
                 pp."downPayment"::float8 AS "downPayment", pp."startDate",
                 coalesce(
                   json_agg(json_build_object(
                     'sequence', i."sequence",
                     'dueMs', (extract(epoch FROM i."dueDate") * 1000)::float8,
                     'amount', i."amount"::float8
                   ) ORDER BY i."sequence") FILTER (WHERE i."id" IS NOT NULL),
                   '[]'::json
                 ) AS "installments"
            FROM "payment_plans" pp
            JOIN "treatment_plans" tp
              ON tp."tenantId" = pp."tenantId" AND tp."id" = pp."treatmentPlanId"
            LEFT JOIN "installments" i
              ON i."tenantId" = pp."tenantId" AND i."paymentPlanId" = pp."id"
           WHERE pp."tenantId" = ${tenantId}::uuid
             AND pp."patientId" = ANY(${ids}::uuid[])
             AND pp."deletedAt" IS NULL
             AND pp."status" <> 'CANCELLED'
             AND tp."deletedAt" IS NULL
           GROUP BY pp."id"`;

        const scheduleBy = groupBy(paymentPlans);
        const ledgers = new Map<string, PatientLedger>();
        for (const p of plans) {
          let ledger = ledgers.get(p.patientId);
          if (!ledger) {
            ledger = {
              patientId: p.patientId,
              locationId: p.locationId,
              plans: [],
              paid: [],
              paymentPlans: (scheduleBy.get(p.patientId) ?? []).map((pp) => ({
                id: pp.id,
                treatmentPlanId: pp.treatmentPlanId,
                currency: pp.currency,
                status: pp.status,
                downPayment: pp.downPayment,
                startDate: pp.startDate,
                installments: pp.installments.map((i) => ({
                  sequence: i.sequence,
                  dueDate: new Date(i.dueMs),
                  amount: i.amount,
                })),
              })),
            };
            ledgers.set(p.patientId, ledger);
          }
          ledger.plans.push({
            id: p.id,
            status: p.status,
            currency: p.currency,
            createdAt: p.createdAt,
            billable: p.billable,
            agingFrom: p.agingFrom,
          });
          if (p.paidOwn !== null) {
            ledger.paid.push({
              treatmentPlanId: p.id,
              currency: p.currency,
              amount: p.paidOwn,
            });
          }
          for (const other of p.paidOther ?? []) {
            ledger.paid.push({
              treatmentPlanId: p.id,
              currency: other.currency,
              amount: other.amount,
            });
          }
        }
        return [...ledgers.values()];
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /** Dos consultas fijas: pacientes con su último abono vivo, y zonas. */
  async loadDebtors(patientIds: readonly string[]): Promise<DebtorDetails[]> {
    const tenantId = this.tenantId();
    if (patientIds.length === 0) return [];
    const ids = [...patientIds];
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.$queryRaw<DebtorSqlRow[]>`
        SELECT pa."id", pa."firstName", pa."lastName", pa."phone",
               pa."countryCode",
               lp."paidAt", lp."amount", lp."currency",
               lp."locationId" AS "paymentLocationId"
          FROM "patients" pa
          LEFT JOIN LATERAL (
            SELECT p."paidAt", p."amount"::float8 AS "amount", p."currency",
                   p."locationId"
              FROM "payments" p
             WHERE p."tenantId" = ${tenantId}::uuid
               AND p."patientId" = pa."id"
               AND p."deletedAt" IS NULL
             ORDER BY p."paidAt" DESC, p."id" DESC
             LIMIT 1
          ) lp ON true
         WHERE pa."tenantId" = ${tenantId}::uuid
           AND pa."id" = ANY(${ids}::uuid[])
           AND pa."deletedAt" IS NULL`;
      const zoneOf = await resolveLocationTimeZones(
        tx,
        tenantId,
        rows.flatMap((r) => (r.paymentLocationId ? [r.paymentLocationId] : [])),
      );
      return rows.map((r) => ({
        patientId: r.id,
        firstName: r.firstName,
        lastName: r.lastName,
        phone: r.phone,
        countryCode: r.countryCode,
        lastPayment:
          r.paidAt && r.amount !== null && r.currency && r.paymentLocationId
            ? {
                paidAt: r.paidAt,
                timeZone: zoneOf(r.paymentLocationId),
                amount: r.amount,
                currency: r.currency,
              }
            : null,
      }));
    });
  }
}
