import { Injectable } from '@nestjs/common';
import {
  CollectionChannel,
  CollectionOutcome,
  PaymentPlanStatus,
  PaymentPromiseStatus,
  Prisma,
  TreatmentPlanStatus,
} from '@prisma/client';
import { phoneRegionOrNull } from '../../../shared/phone/phone-number';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { resolveLocationTimeZones } from '../../../shared/locations/location-time-zone';
import { loadTenantZones } from '../../../shared/locations/reference-location';
import type {
  DebtorCollections,
  DebtorDetails,
  PatientLedger,
} from '../domain/entities/receivables.entity';
import type {
  LedgersQuery,
  ReceivablesLocation,
  ReceivablesRepository,
} from '../domain/ports/receivables-repository.port';

/*
 * Entradas de la cartera de un paciente tal como las guarda `patient_ledgers`
 * (DX-155; formato en la migración 20261017233000_dx155_patient_ledgers).
 */

/**
 * Plan vivo: id, estado, moneda, alta y `agingFrom` (epoch ms), facturable,
 * abonado en su moneda (`null` si nada) y abonado en otra moneda, sumado por
 * moneda (`null` si nada).
 */
type PlanTuple = [
  id: string,
  status: TreatmentPlanStatus,
  currency: string,
  createdMs: number,
  agingFromMs: number,
  billable: number,
  paidOwn: number | null,
  paidOther: [currency: string, amount: number][] | null,
];

/** Plan de cuotas con sus cuotas ([secuencia, vencimiento epoch ms, importe]). */
type PaymentPlanTuple = [
  id: string,
  treatmentPlanId: string,
  currency: string,
  status: PaymentPlanStatus,
  downPayment: number,
  startMs: number,
  installments: [sequence: number, dueMs: number, amount: number][],
];

/** Saldo migrado vivo (DX-262): id, moneda, importe, fecha de corte, aproximada. */
type OpeningTuple = [
  id: string,
  currency: string,
  amount: number,
  asOfDate: string,
  approximate: boolean,
  /** Abonado vivo en su moneda (revisión C1); ausente antes de ella. */
  paid?: number,
];

/** El `ledger` de una fila de `patient_ledgers`. */
interface LedgerJson {
  plans: PlanTuple[];
  paymentPlans: PaymentPlanTuple[];
  /** Ausente en las filas anteriores a DX-262 (sin saldos migrados). */
  openings?: OpeningTuple[];
}

/** Una fila de `patient_ledgers`, con el `ledger` como texto JSON. */
interface LedgerSqlRow {
  patientId: string;
  locationId: string | null;
  ledger: string;
}

export function toLedger({
  patientId,
  locationId,
  ledger: text,
}: LedgerSqlRow): PatientLedger {
  const ledger = JSON.parse(text) as LedgerJson;
  const out: PatientLedger = {
    patientId,
    locationId,
    plans: [],
    paid: [],
    openings: (ledger.openings ?? []).map(
      ([id, currency, amount, asOfDate, approximate]) => ({
        id,
        currency,
        amount,
        asOfDate,
        asOfDateApproximate: approximate,
      }),
    ),
    paymentPlans: ledger.paymentPlans.map(
      ([
        id,
        treatmentPlanId,
        currency,
        status,
        downPayment,
        startMs,
        dues,
      ]) => ({
        id,
        treatmentPlanId,
        currency,
        status,
        downPayment,
        startDate: new Date(startMs),
        installments: dues.map(([sequence, dueMs, amount]) => ({
          sequence,
          dueDate: new Date(dueMs),
          amount,
        })),
      }),
    ),
  };
  for (const [id, currency, , , , paid] of ledger.openings ?? []) {
    if (paid) {
      out.paid.push({
        treatmentPlanId: null,
        openingBalanceId: id,
        currency,
        amount: paid,
      });
    }
  }
  for (const [
    id,
    status,
    currency,
    createdMs,
    agingFromMs,
    billable,
    paidOwn,
    paidOther,
  ] of ledger.plans) {
    out.plans.push({
      id,
      status,
      currency,
      createdAt: new Date(createdMs),
      billable,
      agingFrom: new Date(agingFromMs),
    });
    if (paidOwn !== null) {
      out.paid.push({ treatmentPlanId: id, currency, amount: paidOwn });
    }
    for (const [otherCurrency, amount] of paidOther ?? []) {
      out.paid.push({ treatmentPlanId: id, currency: otherCurrency, amount });
    }
  }
  return out;
}

/**
 * El resumen `patient_ledgers` (DX-155) de ESTOS pacientes con deuda, en UNA
 * consulta por la clave primaria (tenantId, patientId). La usan la marca
 * «Saldo vencido» de la agenda y de la ficha (DX-150): una consulta por lote,
 * sin N+1. Corre en la transacción del llamador (RLS por tenant).
 */
export async function loadLedgersOf(
  tx: Prisma.TransactionClient,
  tenantId: string,
  patientIds: readonly string[],
): Promise<PatientLedger[]> {
  const ids = [...new Set(patientIds)];
  if (ids.length === 0) return [];
  const rows = await tx.$queryRaw<LedgerSqlRow[]>`
    SELECT l."patientId", l."locationId", l."ledger"::text AS "ledger"
      FROM "patient_ledgers" l
     WHERE l."tenantId" = ${tenantId}::uuid
       AND l."patientId" = ANY(${ids}::uuid[])
       AND l."owing"`;
  return rows.map(toLedger);
}

interface DebtorSqlRow {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  paidAt: Date | null;
  amount: number | null;
  currency: string | null;
  paymentLocationId: string | null;
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

  locationTimeZones(): Promise<(locationId: string | null) => string> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant((tx) => loadTenantZones(tx, tenantId));
  }

  async locationPhoneRegions(): Promise<
    (locationId: string | null) => string | null
  > {
    const tenantId = this.tenantId();
    const locations = await this.prisma.runWithTenant((tx) =>
      tx.location.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, defaultPhoneRegion: true, deletedAt: true },
      }),
    );
    const regions = new Map(
      locations.map((l) => [l.id, phoneRegionOrNull(l.defaultPhoneRegion)]),
    );
    const principal = locations.find((l) => l.deletedAt === null)?.id;
    return (locationId) => regions.get(locationId ?? principal ?? '') ?? null;
  }

  /**
   * UNA consulta, sobre el resumen `patient_ledgers` (DX-155): la BD guarda,
   * por paciente y al escribir, lo que antes se reunía aquí en cada petición
   * agregando todos los ítems, abonos, cuotas y citas atendidas de la clínica
   * (docs/perf/DX-145.md). Cada fila trae:
   *    - las SUMAS de cada plan vivo: `billable` (Σ precio − Σ descuento de
   *      los ítems vivos ACCEPTED|DONE, el facturable del estado de cuenta),
   *      lo abonado en su moneda y lo abonado en otra moneda por moneda
   *      (`computeBalances` los suma igual que sueltos); y `agingFrom`
   *      (aceptación firmada, presentación o creación del plan);
   *    - los planes de cuotas vivos no cancelados de planes vivos, con sus
   *      cuotas;
   *    - SEDE DE LA DEUDA: la de su última cita ATENDIDA (COMPLETED, viva); si
   *      nunca fue atendido, la de su último abono vivo; si tampoco, la de la
   *      última presentación de un plan. Sin ninguna, `null`: solo sale en la
   *      vista consolidada. Se filtra por la sede pedida;
   *    - `owing` = paciente vivo con algún plan vivo cuyo facturable supera lo
   *      abonado en la moneda del plan (índice parcial
   *      patient_ledgers_owing_idx). Es un SUPERCONJUNTO exacto de quien tiene
   *      deuda en `computeBalances` (la deuda sale solo de planes con saldo
   *      > 0, y el saldo a favor nunca la compensa), así que no decide nada:
   *      solo evita traer a quien lo tiene todo pagado.
   * El cálculo (estados que cuentan, cuotas, monedas, tramos) sigue siendo el
   * del estado de cuenta, en la aplicación. El `ledger` llega como texto y se
   * lee con `JSON.parse`: con miles de filas es lo más barato (medido en
   * docs/perf/DX-145.md: el jsonb convertido por Prisma, o todo en un único
   * texto, cuesta más). Una sola sentencia: una sola foto, sin REPEATABLE
   * READ.
   */
  async loadLedgers(query: LedgersQuery): Promise<PatientLedger[]> {
    const tenantId = this.tenantId();
    // Sede pedida; si no, las permitidas al miembro (DX-089); sin restricción,
    // toda la clínica.
    const scopeIds = query.locationId
      ? [query.locationId]
      : this.tenantContext.scopeLocationIds();
    const locationFilter = scopeIds
      ? Prisma.sql`AND l."locationId" = ANY(${scopeIds}::uuid[])`
      : Prisma.empty;

    const rows = await this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<LedgerSqlRow[]>`
          SELECT l."patientId", l."locationId", l."ledger"::text AS "ledger"
            FROM "patient_ledgers" l
           WHERE l."tenantId" = ${tenantId}::uuid
             AND l."owing"
             ${locationFilter}`,
    );
    return rows.map(toLedger);
  }

  /** Dos consultas fijas: pacientes con su último abono vivo, y zonas. */
  async loadDebtors(patientIds: readonly string[]): Promise<DebtorDetails[]> {
    const tenantId = this.tenantId();
    if (patientIds.length === 0) return [];
    const ids = [...patientIds];
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.$queryRaw<DebtorSqlRow[]>`
        SELECT pa."id", pa."firstName", pa."lastName", pa."phone",
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

  /** DX-150: por payment_promises_open_patient_key (parcial, OPEN). */
  async patientsWithOpenPromise(
    patientIds: readonly string[],
  ): Promise<Set<string>> {
    const tenantId = this.tenantId();
    if (patientIds.length === 0) return new Set();
    const ids = [...patientIds];
    const rows = await this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<{ patientId: string }[]>`
          SELECT pp."patientId"
            FROM "payment_promises" pp
           WHERE pp."tenantId" = ${tenantId}::uuid
             AND pp."status" = 'OPEN'
             AND pp."patientId" = ANY(${ids}::uuid[])`,
    );
    return new Set(rows.map((r) => r.patientId));
  }

  /**
   * DX-150: profesional de la última cita ATENDIDA de cada paciente, por
   * appointments_tenant_patient_completed_idx (DX-145), en una consulta.
   */
  async patientsOfProvider(
    providerId: string,
    patientIds: readonly string[],
  ): Promise<Set<string>> {
    const tenantId = this.tenantId();
    if (patientIds.length === 0) return new Set();
    const ids = [...patientIds];
    const rows = await this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<{ patientId: string }[]>`
          SELECT last."patientId"
            FROM unnest(${ids}::uuid[]) AS p("id")
            JOIN LATERAL (
              SELECT a."patientId", a."providerId"
                FROM "appointments" a
               WHERE a."tenantId" = ${tenantId}::uuid
                 AND a."patientId" = p."id"
                 AND a."status" = 'COMPLETED'
                 AND a."deletedAt" IS NULL
               ORDER BY a."start" DESC, a."id" DESC
               LIMIT 1
            ) last ON true
           WHERE last."providerId" = ${providerId}::uuid`,
    );
    return new Set(rows.map((r) => r.patientId));
  }

  /**
   * DX-150: última gestión y último compromiso de los pacientes de la página,
   * en dos consultas por los índices (tenantId, patientId, createdAt DESC).
   */
  async loadCollections(
    patientIds: readonly string[],
  ): Promise<Map<string, DebtorCollections>> {
    const tenantId = this.tenantId();
    const out = new Map<string, DebtorCollections>();
    if (patientIds.length === 0) return out;
    const ids = [...patientIds];
    return this.prisma.runWithTenant(async (tx) => {
      const notes = await tx.$queryRaw<
        {
          patientId: string;
          channel: CollectionChannel;
          outcome: CollectionOutcome;
          createdAt: Date;
        }[]
      >`
        SELECT DISTINCT ON (n."patientId")
               n."patientId", n."channel", n."outcome", n."createdAt"
          FROM "collection_notes" n
         WHERE n."tenantId" = ${tenantId}::uuid
           AND n."patientId" = ANY(${ids}::uuid[])
         ORDER BY n."patientId", n."createdAt" DESC, n."id" DESC`;
      const promises = await tx.$queryRaw<
        {
          id: string;
          patientId: string;
          amount: number;
          currency: string;
          dueDate: string;
          status: PaymentPromiseStatus;
          reopenedAt: Date | null;
        }[]
      >`
        SELECT DISTINCT ON (pp."patientId")
               pp."id", pp."patientId", pp."amount"::float8 AS "amount",
               pp."currency", to_char(pp."dueDate", 'YYYY-MM-DD') AS "dueDate",
               pp."status", pp."reopenedAt"
          FROM "payment_promises" pp
         WHERE pp."tenantId" = ${tenantId}::uuid
           AND pp."patientId" = ANY(${ids}::uuid[])
         ORDER BY pp."patientId", pp."createdAt" DESC, pp."id" DESC`;
      const entry = (patientId: string): DebtorCollections => {
        const existing = out.get(patientId);
        if (existing) return existing;
        const created: DebtorCollections = { lastNote: null, promise: null };
        out.set(patientId, created);
        return created;
      };
      for (const n of notes) {
        entry(n.patientId).lastNote = {
          channel: n.channel,
          outcome: n.outcome,
          createdAt: n.createdAt,
        };
      }
      for (const p of promises) {
        entry(p.patientId).promise = {
          id: p.id,
          amount: p.amount,
          currency: p.currency,
          dueDate: p.dueDate,
          status: p.status,
          reopenedAt: p.reopenedAt,
        };
      }
      return out;
    });
  }
}
