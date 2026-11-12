import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Prisma,
  type RecallContactChannel,
  type RecallContactOutcome,
  type RecallKind,
  type RecallSource,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { requireLocationTimeZone } from '../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../shared/time/civil-day';
import { lockRow } from '../../../shared/prisma/lock-row';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../audit/domain/config-audit';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import { recallTypeSnapshot } from '../domain/recall-type-audit';
import { RECALL_TYPE_SORT_STEP } from '../domain/recall-type-rules';
import {
  auditExclusions,
  deactivateExcluded,
  lockExclusionScope,
} from './recall-exclusion';
import type { RecallRepository } from '../domain/ports/recall-repository.port';
import type {
  NewRecallContact,
  PatientRecallRow,
  RecallContactView,
  RecallDueQuery,
  RecallDueRow,
  NewRecallType,
  RecallExclusionUpdate,
  RecallRef,
  RecallTypeFields,
  RecallTypeRef,
  RecallTypeView,
  SetPatientRecallData,
  StaffRef,
} from '../domain/recall.entity';

const RECALL_TYPE_AUDIT = { resourceType: 'RECALL_TYPE' } as const;

/** Igual que el de los casos de uso (no se importa de la capa de aplicación). */
const RECALL_TYPE_NOT_FOUND_MESSAGE =
  'Ese tipo de recall no existe en esta clínica.';

export const DUPLICATE_RECALL_TYPE_MESSAGE =
  'Ya existe un tipo de recall con ese nombre.';
export const INVALID_RECALL_TRIGGERS_MESSAGE =
  'Hay procedimientos que no existen en el catálogo de esta clínica o están retirados.';

/**
 * El único UNIQUE que una escritura de tipos puede violar desde la API es el
 * del nombre entre vivos (`recall_types_tenant_name_ci_key`). Bajo RLS Prisma
 * no informa `meta.target`: se traduce aquí, como en los tipos de cita.
 */
function rethrowDuplicateTypeName(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw new ConflictException(DUPLICATE_RECALL_TYPE_MESSAGE);
  }
  throw error;
}

const TYPE_VIEW_SELECT = {
  id: true,
  name: true,
  defaultIntervalMonths: true,
  active: true,
  sortOrder: true,
  systemKey: true,
  exclusionGroup: true,
  triggers: {
    select: {
      catalogItemId: true,
      catalogItem: { select: { code: true, labelEs: true } },
    },
    orderBy: { catalogItemId: 'asc' },
  },
} as const satisfies Prisma.RecallTypeSelect;

type TypeViewRow = Prisma.RecallTypeGetPayload<{
  select: typeof TYPE_VIEW_SELECT;
}>;

function toTypeView({ triggers, ...type }: TypeViewRow): RecallTypeView {
  return {
    ...type,
    triggerCatalogItemIds: triggers.map((t) => t.catalogItemId),
    triggers: triggers.map((t) => ({
      catalogItemId: t.catalogItemId,
      code: t.catalogItem.code,
      name: t.catalogItem.labelEs,
    })),
  };
}

/**
 * El tipo bloqueado (FOR UPDATE) hasta el final de la transacción y releído
 * después del bloqueo: el «antes» de la auditoría es el que de verdad cambia
 * (DX-360). 404 si lo retiraron mientras tanto.
 */
async function lockedLiveType(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<RecallTypeView> {
  await lockRow(tx, 'recall_types', id);
  const row = await tx.recallType.findFirst({
    where: { id, deletedAt: null },
    select: TYPE_VIEW_SELECT,
  });
  if (!row) throw new NotFoundException(RECALL_TYPE_NOT_FOUND_MESSAGE);
  return toTypeView(row);
}

/** DATE de Postgres -> día civil (Prisma lo trae a medianoche UTC). */
const civilOf = (date: Date): string => date.toISOString().slice(0, 10);
const dateOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

const CONTACT_SELECT = {
  id: true,
  recallId: true,
  patientId: true,
  locationId: true,
  channel: true,
  outcome: true,
  note: true,
  appointmentId: true,
  authorId: true,
  createdAt: true,
  recall: {
    select: {
      kind: true,
      recallTypeId: true,
      recallType: { select: { name: true } },
    },
  },
} as const satisfies Prisma.RecallContactSelect;

type ContactRow = Prisma.RecallContactGetPayload<{
  select: typeof CONTACT_SELECT;
}>;

/** Columnas de una fila de la página de `recallDueSql`. */
interface DuePageColumns {
  recallId: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  patientPhone: string | null;
  phoneRegion: string | null;
  reminderOptedOut: boolean;
  kind: RecallKind | null;
  recallTypeId: string;
  recallTypeName: string;
  intervalMonths: number;
  baseDate: Date;
  dueAt: Date;
  daysOverdue: number;
  locationId: string;
  lastContactChannel: RecallContactChannel | null;
  lastContactOutcome: RecallContactOutcome | null;
  lastContactAt: Date | null;
}

/**
 * Lo que devuelve `recallDueSql`: el total en cada fila y, en la fila única de
 * una página vacía (fuera de rango o sin recall), TODAS las columnas de la
 * página a NULL. `recallId === null` distingue los dos casos.
 */
type DueSqlRow = { total: number } & (
  DuePageColumns | { [K in keyof DuePageColumns]: null }
);

export interface RecallDueSqlParams extends RecallDueQuery {
  tenantId: string;
  /** Sedes del request (activa o permitidas); `undefined` = sin restricción. */
  locationIds?: readonly string[];
}

/**
 * DX-547 (DB-079) · La lista de llamada en UNA sentencia: el total y la
 * página salen de la misma evaluación de `d` (MATERIALIZED), y siempre vuelve
 * al menos una fila con el total (en una página fuera de rango, sin recall).
 *
 * DX-015-bis: el vencimiento es el GUARDADO (`dueAt`, columna generada:
 * "lastDoneAt" + intervalo), que ya no depende de la última visita. En orden:
 * 0. `locs`: las sedes de la clínica con su «hoy» (2–20 filas, una vez).
 * 1. `c`: los recall ACTIVOS de la clínica que pueden salir: un RANGO SOLO de
 *    índice sobre `patient_recalls_tenant_due_visit_idx` ("dueAt" <= el «hoy»
 *    más adelantado de las sedes de la clínica + la ventana; `maxToday` es un
 *    InitPlan, así que la cota va en el propio recorrido del índice). «Hoy»
 *    en la sede del paciente nunca pasa de `maxToday`, así que la cota solo
 *    descarta lo que tampoco saldría después. Sin cita futura ni en la
 *    clínica (`appointments_tenant_patient_upcoming_idx`; no depende de la
 *    sede). Sin columnas del paciente: la fila es estrecha.
 * 2. `d`: la sede del paciente es la de su última cita atendida, GUARDADA en
 *    el recall ("visitLocationId", la mantienen los triggers de
 *    20261212090400) o, sin ella, la del recall; su «hoy» sale de `locs`. Ahí
 *    se aplican el filtro exacto por ese «hoy» y el de sede, y solo a lo que
 *    queda se le busca el paciente (vivo, nombre y teléfono). Sin LATERAL a
 *    appointments por candidato (REPORT-1A-R5 de DX-015-bis).
 * 3. El nombre del tipo y el último contacto, solo de la página.
 */
export function recallDueSql(p: RecallDueSqlParams): Prisma.Sql {
  const kindFilter = p.kind
    ? Prisma.sql`AND pr."kind" = ${p.kind}::"RecallKind"`
    : Prisma.empty;
  const typeFilter = p.recallTypeId
    ? Prisma.sql`AND pr."recallTypeId" = ${p.recallTypeId}::uuid`
    : Prisma.empty;
  const order = (alias: Prisma.Sql) =>
    p.sort === 'MOST_OVERDUE'
      ? Prisma.sql`${alias}."dueIn" ASC, ${alias}."lastName" ASC, ${alias}."firstName" ASC, ${alias}."id" ASC`
      : Prisma.sql`${alias}."dueIn" DESC, ${alias}."lastName" ASC, ${alias}."firstName" ASC, ${alias}."id" ASC`;
  const offset = (p.page - 1) * p.pageSize;
  return Prisma.sql`
    WITH locs AS MATERIALIZED (
      SELECT l."id", l."defaultPhoneRegion",
             ((${p.now}::timestamptz) AT TIME ZONE coalesce(l."timeZone", 'UTC'))::date AS "today"
        FROM "locations" l
       WHERE l."tenantId" = ${p.tenantId}::uuid
    ),
    bound AS (
      SELECT max(locs."today") AS "maxToday" FROM locs
    ),
    c AS MATERIALIZED (
      SELECT pr."id", pr."tenantId", pr."patientId", pr."kind", pr."recallTypeId",
             pr."intervalMonths", pr."lastDoneAt", pr."dueAt", pr."disabledUntil",
             pr."locationId", pr."visitLocationId"
        FROM "patient_recalls" pr
       WHERE pr."tenantId" = ${p.tenantId}::uuid
         AND pr."active"
         AND pr."dueAt" <= (SELECT "maxToday" FROM bound) + ${p.withinDays}::int
         ${kindFilter}
         ${typeFilter}
         AND (pr."disabledUntil" IS NULL OR pr."disabledUntil" <= (SELECT "maxToday" FROM bound))
         AND NOT EXISTS (
           SELECT 1 FROM "appointments" a
            WHERE a."tenantId" = pr."tenantId"
              AND a."patientId" = pr."patientId"
              AND a."deletedAt" IS NULL
              -- El predicado del índice parcial, literal: Postgres no lo
              -- deduce del OR de abajo y sin él no usa el índice.
              AND a."status" IN ('SCHEDULED', 'CONFIRMED', 'ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT')
              AND (
                (a."status" IN ('SCHEDULED', 'CONFIRMED') AND a."start" > ${p.now})
                OR a."status" IN ('ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT')
              )
         )
    ),
    d AS MATERIALIZED (
      SELECT c."id", c."tenantId", c."patientId", c."kind", c."recallTypeId",
             c."intervalMonths", pa."firstName", pa."lastName", pa."phone",
             (pa."reminderOptOutAt" IS NOT NULL) AS "reminderOptedOut",
             lo."id" AS "homeLocationId", lo."defaultPhoneRegion" AS "phoneRegion",
             lo."today",
             c."lastDoneAt" AS "baseDate", c."dueAt", c."dueAt" - lo."today" AS "dueIn"
        FROM c
        JOIN locs lo ON lo."id" = coalesce(c."visitLocationId", c."locationId")
        -- DX-015-bis (D11): los recalls de un tipo retirado no salen (la
        -- tabla de tipos es pequeña: un hash sobre lo que ya quedó).
        JOIN "recall_types" ty
          ON ty."tenantId" = c."tenantId" AND ty."id" = c."recallTypeId"
         AND ty."deletedAt" IS NULL
        JOIN "patients" pa
          ON pa."tenantId" = c."tenantId" AND pa."id" = c."patientId"
       WHERE c."dueAt" <= lo."today" + ${p.withinDays}::int
         AND (c."disabledUntil" IS NULL OR c."disabledUntil" <= lo."today")
         AND pa."deletedAt" IS NULL
         ${p.locationIds ? Prisma.sql`AND lo."id" = ANY(${p.locationIds}::uuid[])` : Prisma.empty}
    ),
    page AS (
      SELECT d.* FROM d
       ORDER BY ${order(Prisma.raw('d'))}
       LIMIT ${p.pageSize} OFFSET ${offset}
    )
    SELECT t."total",
           pg."id" AS "recallId",
           pg."patientId",
           pg."firstName" AS "patientFirstName",
           pg."lastName" AS "patientLastName",
           pg."phone" AS "patientPhone",
           pg."phoneRegion",
           pg."reminderOptedOut",
           pg."kind",
           pg."recallTypeId",
           rt."name" AS "recallTypeName",
           pg."intervalMonths",
           pg."baseDate",
           pg."dueAt",
           (pg."today" - pg."dueAt")::int AS "daysOverdue",
           pg."homeLocationId" AS "locationId",
           rc."channel" AS "lastContactChannel",
           rc."outcome" AS "lastContactOutcome",
           rc."createdAt" AS "lastContactAt"
      FROM (SELECT count(*)::int AS "total" FROM d) t
      LEFT JOIN page pg ON true
      LEFT JOIN "recall_types" rt
        ON rt."tenantId" = pg."tenantId" AND rt."id" = pg."recallTypeId"
      LEFT JOIN LATERAL (
        SELECT x."channel", x."outcome", x."createdAt"
          FROM "recall_contacts" x
         WHERE x."tenantId" = pg."tenantId"
           AND x."recallId" = pg."id"
         ORDER BY x."createdAt" DESC, x."id" DESC
         LIMIT 1
      ) rc ON true
     ORDER BY ${order(Prisma.raw('pg'))}`;
}

/**
 * DX-015-bis: una clínica dada de alta por la app anterior durante el
 * despliegue no tiene tipos; se le siembran los de por defecto la primera vez
 * que se necesitan (idempotente; no hace nada si tiene alguno, también
 * retirado).
 */
export async function ensureDefaultTypes(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT public.dx_recall_ensure_default_types(${tenantId}::uuid)`;
}

/**
 * DX-015 · Recall sobre Prisma. DX-015-bis: el vencimiento es la columna
 * generada `dueAt` y la base la mantiene `dx_recall_recompute` (lo fijado a
 * mano o el último DONE de un procedimiento disparador del tipo).
 */
@Injectable()
export class PrismaRecallRepository implements RecallRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Los recalls de pacientes con su tipo, su sede (la de la última cita
   * atendida o, sin ella, la del recall), hoy en la zona de esa sede, la base
   * y el vencimiento guardado. `extra` acota (paciente, recall).
   */
  private recallFacts(now: Date, extra: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`
      SELECT pr."id", pr."tenantId", pr."patientId", pr."kind",
             pr."recallTypeId", rt."name" AS "recallTypeName", rt."sortOrder",
             pr."intervalMonths", pr."lastDoneAt", pr."dueAt", pr."manualDoneAt",
             pr."lastDoneItemId", pr."source", pr."preBackfillDoneAt",
             pr."active", pr."disabledUntil",
             pr."disabledReason", pr."updatedAt", pr."updatedById",
             pa."firstName", pa."lastName", pa."phone",
             (pa."reminderOptOutAt" IS NOT NULL) AS "reminderOptedOut",
             lo."id" AS "homeLocationId",
             lo."defaultPhoneRegion" AS "phoneRegion",
             ((${now}::timestamptz) AT TIME ZONE coalesce(lo."timeZone", 'UTC'))::date AS "today",
             EXISTS (
               SELECT 1 FROM "appointments" a
                WHERE a."tenantId" = pr."tenantId"
                  AND a."patientId" = pr."patientId"
                  AND a."deletedAt" IS NULL
                  AND (
                    (a."status" IN ('SCHEDULED', 'CONFIRMED') AND a."start" > ${now})
                    OR a."status" IN ('ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT')
                  )
             ) AS "hasUpcomingAppointment"
        FROM "patient_recalls" pr
        JOIN "patients" pa
          ON pa."tenantId" = pr."tenantId" AND pa."id" = pr."patientId"
        -- DX-015-bis (D11): sin los de un tipo retirado.
        JOIN "recall_types" rt
          ON rt."tenantId" = pr."tenantId" AND rt."id" = pr."recallTypeId"
         AND rt."deletedAt" IS NULL
        -- Última cita atendida (appointments_tenant_patient_completed_idx):
        -- solo la sede del paciente.
        LEFT JOIN LATERAL (
          SELECT a."locationId"
            FROM "appointments" a
           WHERE a."tenantId" = pr."tenantId"
             AND a."patientId" = pr."patientId"
             AND a."status" = 'COMPLETED'
             AND a."deletedAt" IS NULL
           ORDER BY a."start" DESC, a."id" DESC
           LIMIT 1
        ) lc ON true
        JOIN "locations" lo
          ON lo."tenantId" = pr."tenantId"
         AND lo."id" = coalesce(lc."locationId", pr."locationId")
       WHERE TRUE ${extra}`;
  }

  async listDue(
    query: RecallDueQuery,
  ): Promise<{ rows: RecallDueRow[]; total: number }> {
    // La sede del request o, sin ella, las permitidas al miembro (DX-089).
    const sql = recallDueSql({
      ...query,
      tenantId: this.tenantId(),
      locationIds: this.tenantContext.scopeLocationIds(),
    });
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.$queryRaw<DueSqlRow[]>(sql);
      return {
        total: rows[0]?.total ?? 0,
        rows: rows.flatMap((r) =>
          r.recallId === null
            ? []
            : [
                {
                  recallId: r.recallId,
                  patientId: r.patientId,
                  patientFirstName: r.patientFirstName,
                  patientLastName: r.patientLastName,
                  patientPhone: r.patientPhone,
                  phoneRegion: r.phoneRegion,
                  reminderOptedOut: r.reminderOptedOut,
                  kind: r.kind,
                  recallTypeId: r.recallTypeId,
                  recallTypeName: r.recallTypeName,
                  intervalMonths: r.intervalMonths,
                  baseDate: civilOf(r.baseDate),
                  dueAt: civilOf(r.dueAt),
                  daysOverdue: r.daysOverdue,
                  locationId: r.locationId,
                  lastContact:
                    r.lastContactChannel &&
                    r.lastContactOutcome &&
                    r.lastContactAt
                      ? {
                          channel: r.lastContactChannel,
                          outcome: r.lastContactOutcome,
                          createdAt: r.lastContactAt,
                        }
                      : null,
                },
              ],
        ),
      };
    });
  }

  patientExists(patientId: string): Promise<boolean> {
    return this.prisma.runWithTenant(async (tx) => {
      const found = await tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: { id: true },
      });
      return found !== null;
    });
  }

  async patientRecalls(
    patientId: string,
    now: Date,
  ): Promise<{ rows: PatientRecallRow[]; contacts: RecallContactView[] }> {
    return this.prisma.runWithTenant(async (tx) => {
      const facts = await tx.$queryRaw<
        {
          id: string;
          kind: RecallKind | null;
          recallTypeId: string;
          recallTypeName: string;
          intervalMonths: number;
          lastDoneAt: Date;
          dueAt: Date;
          manualDoneAt: Date | null;
          lastDoneItemId: string | null;
          source: RecallSource;
          preBackfillDoneAt: Date | null;
          active: boolean;
          disabledUntil: Date | null;
          disabledReason: string | null;
          homeLocationId: string;
          today: Date;
          hasUpcomingAppointment: boolean;
          updatedAt: Date;
          updatedById: string;
        }[]
      >`${this.recallFacts(now, Prisma.sql`AND pr."patientId" = ${patientId}::uuid`)}
        ORDER BY rt."sortOrder" ASC, rt."name" ASC, pr."id" ASC`;
      const contactRows = await tx.recallContact.findMany({
        where: { patientId },
        select: CONTACT_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      });
      const names = await this.staffNames(tx, [
        ...facts.map((f) => f.updatedById),
        ...contactRows.map((c) => c.authorId),
      ]);
      return {
        rows: facts.map((f) => ({
          id: f.id,
          kind: f.kind,
          recallTypeId: f.recallTypeId,
          recallTypeName: f.recallTypeName,
          intervalMonths: f.intervalMonths,
          lastDoneAt: civilOf(f.lastDoneAt),
          dueAt: civilOf(f.dueAt),
          manualDoneAt: f.manualDoneAt ? civilOf(f.manualDoneAt) : null,
          lastDoneItemId: f.lastDoneItemId,
          source: f.source,
          preBackfillDoneAt: f.preBackfillDoneAt
            ? civilOf(f.preBackfillDoneAt)
            : null,
          active: f.active,
          disabledUntil: f.disabledUntil ? civilOf(f.disabledUntil) : null,
          disabledReason: f.disabledReason,
          locationId: f.homeLocationId,
          hasUpcomingAppointment: f.hasUpcomingAppointment,
          today: civilOf(f.today),
          updatedAt: f.updatedAt,
          updatedById: f.updatedById,
        })),
        contacts: contactRows.map((c) => this.toContact(c, names)),
      };
    });
  }

  writeToday(now: Date): Promise<string> {
    return this.prisma.runWithTenant(async (tx) => {
      const locationId = await this.tenantContext.writeLocationId(tx);
      const location = await tx.location.findFirstOrThrow({
        where: { id: locationId },
        select: { id: true, timeZone: true },
      });
      return civilDateIn(now, requireLocationTimeZone(location));
    });
  }

  /**
   * DX-015-bis: crea o cambia el único recall del paciente de ese tipo y
   * recalcula su base en la MISMA transacción: lo fijado va a "manualDoneAt"
   * y "lastDoneAt" queda en el máximo con el último DONE de un disparador
   * (`dx_recall_recompute`). El alta va a la sede de trabajo.
   *
   * Sin fecha fijada (`manualDoneAt` undefined), un recall que ya existe no
   * toca "manualDoneAt" (también null), "lastDoneAt", "preBackfillDoneAt" ni
   * "lastDoneItemId": cambiar el intervalo o pausarlo no reinicia el reloj. El
   * trigger de compatibilidad no interviene (no cambia "lastDoneAt"). Un alta
   * sin fecha nace con `newRecallDoneAt` (hoy).
   */
  upsertRecall(
    data: SetPatientRecallData,
  ): Promise<{ id: string; excluded: RecallExclusionUpdate[] }> {
    return this.prisma.runWithTenant(async (tx) => {
      const tenantId = this.tenantId();
      const group = data.recallType.exclusionGroup;
      // D9: antes de escribir, el bloqueo del paciente y sus recalls en orden.
      await lockExclusionScope(
        tx,
        tenantId,
        data.patientId,
        group ? [group] : [],
      );
      const base = {
        // Compatibilidad (D7): la clave del tipo, si tiene.
        kind: data.recallType.systemKey,
        intervalMonths: data.intervalMonths,
        active: data.active,
        disabledUntil: data.disabledUntil ? dateOf(data.disabledUntil) : null,
        disabledReason: data.disabledUntil ? data.disabledReason : null,
        updatedById: data.actorId,
        // Activo = ya no está excluido; inactivo, se conserva cómo quedó.
        ...(data.active ? { excludedAt: null } : {}),
      };
      const doneFields = (day: string) => {
        const manualDoneAt = dateOf(day);
        return {
          manualDoneAt,
          lastDoneAt: manualDoneAt,
          // Lo fijado ahora es de verdad del clínico (ya no la base congelada).
          preBackfillDoneAt: null,
        };
      };
      const fields =
        data.manualDoneAt === undefined
          ? base
          : { ...base, ...doneFields(data.manualDoneAt) };
      const existing = await tx.patientRecall.findFirst({
        where: { patientId: data.patientId, recallTypeId: data.recallType.id },
        select: { id: true, active: true },
      });
      const row = existing
        ? await tx.patientRecall.update({
            where: { id: existing.id },
            data: fields,
            select: { id: true },
          })
        : await tx.patientRecall.create({
            data: {
              tenantId,
              patientId: data.patientId,
              recallTypeId: data.recallType.id,
              locationId: await this.tenantContext.writeLocationId(tx),
              createdById: data.actorId,
              source: 'MANUAL',
              ...base,
              ...doneFields(data.manualDoneAt ?? data.newRecallDoneAt),
            },
            select: { id: true },
          });
      await tx.$executeRaw`SELECT public.dx_recall_recompute(${tenantId}::uuid, ${data.patientId}::uuid, ${data.recallType.id}::uuid)`;

      // D9: un alta o una reactivación de un tipo con grupo desactiva los
      // demás recalls activos del paciente de ese grupo. Cambiar el
      // intervalo o pausar uno que ya estaba activo no.
      if (!group || !data.active || existing?.active) {
        return { id: row.id, excluded: [] };
      }
      const now = await tx.patientRecall.findUniqueOrThrow({
        where: { id: row.id },
        select: { lastDoneAt: true, intervalMonths: true },
      });
      const excluded = await deactivateExcluded(tx, {
        tenantId,
        patientId: data.patientId,
        candidates: [
          {
            recallId: row.id,
            recallTypeId: data.recallType.id,
            recallTypeName: data.recallType.name,
            exclusionGroup: group,
            lastDoneAt: civilOf(now.lastDoneAt),
            intervalMonths: now.intervalMonths,
          },
        ],
        actorId: data.actorId,
      });
      await auditExclusions(tx, excluded, data.patientId, data.audit);
      return {
        id: row.id,
        excluded: excluded.map((e) => ({
          recallId: e.recallId,
          recallTypeId: e.recallTypeId,
          recallTypeName: e.recallTypeName,
          dueAt: e.dueAt,
          deactivated: true as const,
          replacedBy: {
            recallTypeId: e.replacedBy.recallTypeId,
            recallTypeName: e.replacedBy.recallTypeName,
          },
        })),
      };
    });
  }

  /**
   * DX-015-bis: el tipo vivo con esa clave del enum o ese id; null si no hay.
   * Vale también uno desactivado, a propósito: sus recalls ya existentes se
   * siguen pausando, retirando o corrigiendo a mano (desactivar el tipo solo
   * deja de crearlos por procedimiento).
   */
  findType(
    ref: { systemKey: RecallKind } | { id: string },
  ): Promise<RecallTypeRef | null> {
    return this.prisma.runWithTenant(async (tx) => {
      await ensureDefaultTypes(tx, this.tenantId());
      return tx.recallType.findFirst({
        where: {
          deletedAt: null,
          ...('id' in ref ? { id: ref.id } : { systemKey: ref.systemKey }),
        },
        select: { id: true, name: true, systemKey: true, exclusionGroup: true },
      });
    });
  }

  /** DX-015-bis: los tipos vivos de la clínica (activos o no), en su orden. */
  listTypes(): Promise<RecallTypeView[]> {
    return this.prisma.runWithTenant(async (tx) => {
      await ensureDefaultTypes(tx, this.tenantId());
      const rows = await tx.recallType.findMany({
        where: { deletedAt: null },
        select: TYPE_VIEW_SELECT,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      });
      return rows.map(toTypeView);
    });
  }

  findTypeView(id: string): Promise<RecallTypeView | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.recallType.findFirst({
        where: { id, deletedAt: null },
        select: TYPE_VIEW_SELECT,
      });
      return row ? toTypeView(row) : null;
    });
  }

  /**
   * D11: alta de un tipo. Antes, los tipos por defecto si la clínica no tiene
   * ninguno (si no, el primer alta los dejaría sin sembrar para siempre). Sin
   * orden, va el último (el mayor + 10).
   */
  createType(
    data: NewRecallType,
    audit: AuditRequestContext,
  ): Promise<RecallTypeView> {
    const tenantId = this.tenantId();
    return this.prisma
      .runWithTenant(async (tx) => {
        await ensureDefaultTypes(tx, tenantId);
        let sortOrder = data.sortOrder;
        if (sortOrder === undefined) {
          const last = await tx.recallType.aggregate({
            where: { deletedAt: null },
            _max: { sortOrder: true },
          });
          sortOrder = (last._max.sortOrder ?? 0) + RECALL_TYPE_SORT_STEP;
        }
        const created = toTypeView(
          await tx.recallType.create({
            data: {
              tenantId,
              name: data.name,
              defaultIntervalMonths: data.defaultIntervalMonths,
              active: data.active,
              sortOrder,
              exclusionGroup: data.exclusionGroup,
            },
            select: TYPE_VIEW_SELECT,
          }),
        );
        await writeAuditEvent(
          tx,
          configAuditEvent(audit, {
            ...RECALL_TYPE_AUDIT,
            action: 'CREATE',
            resourceId: created.id,
            reason: 'RECALL_TYPE_CREATED',
            after: recallTypeSnapshot(created),
          }),
        );
        return created;
      })
      .catch(rethrowDuplicateTypeName);
  }

  /**
   * D11: cambiar el intervalo por defecto NO toca los recalls que ya existen
   * (solo los que se creen después); cambiar el grupo tampoco desactiva nada
   * por sí solo: la exclusión se aplica en el siguiente DONE o PUT (D10).
   */
  updateType(
    id: string,
    data: Partial<RecallTypeFields>,
    audit: AuditRequestContext,
  ): Promise<RecallTypeView> {
    return this.prisma
      .runWithTenant(async (tx) => {
        // El antes, con la fila bloqueada hasta el final (DX-360).
        const before = await lockedLiveType(tx, id);
        const after = toTypeView(
          await tx.recallType.update({
            where: { id },
            data: {
              name: data.name,
              defaultIntervalMonths: data.defaultIntervalMonths,
              active: data.active,
              sortOrder: data.sortOrder,
              exclusionGroup: data.exclusionGroup,
            },
            select: TYPE_VIEW_SELECT,
          }),
        );
        const event = configAuditEvent(audit, {
          ...RECALL_TYPE_AUDIT,
          action: 'UPDATE',
          resourceId: id,
          reason: 'RECALL_TYPE_UPDATED',
          before: recallTypeSnapshot(before),
          after: recallTypeSnapshot(after),
        });
        if (event) await writeAuditEvent(tx, event);
        return after;
      })
      .catch(rethrowDuplicateTypeName);
  }

  /**
   * D11: borrado lógico (y desactivado: deja de crear recalls). Sus recalls
   * se conservan, pero ya no salen en la lista ni en la ficha (filtran por
   * tipo vivo). El nombre queda libre para otro tipo.
   */
  retireType(id: string, audit: AuditRequestContext): Promise<void> {
    return this.prisma.runWithTenant(async (tx) => {
      const before = await lockedLiveType(tx, id);
      await tx.recallType.update({
        where: { id },
        data: { active: false, deletedAt: new Date() },
      });
      await writeAuditEvent(
        tx,
        configAuditEvent(audit, {
          ...RECALL_TYPE_AUDIT,
          action: 'DELETE',
          resourceId: id,
          reason: 'RECALL_TYPE_DELETED',
          before: recallTypeSnapshot(before),
        }),
      );
    });
  }

  /**
   * D12: reemplaza el conjunto de disparadores. Cada id nuevo tiene que ser un
   * procedimiento (kind PROCEDURE) vivo del catálogo de la clínica (bajo RLS,
   * uno de otra clínica no existe); uno que el tipo ya tenía se puede
   * conservar aunque se haya retirado del catálogo después. Un procedimiento
   * puede disparar varios tipos. Auditado con los ids de antes y de después
   * (sin evento si no cambia nada).
   */
  setTriggers(
    id: string,
    catalogItemIds: readonly string[],
    audit: AuditRequestContext,
  ): Promise<RecallTypeView> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const before = await lockedLiveType(tx, id);
      const had = new Set(before.triggerCatalogItemIds);
      const added = catalogItemIds.filter((c) => !had.has(c));
      if (added.length > 0) {
        const valid = await tx.dentalCatalogItem.count({
          where: { id: { in: added }, deletedAt: null, kind: 'PROCEDURE' },
        });
        if (valid !== added.length) {
          throw new UnprocessableEntityException(
            INVALID_RECALL_TRIGGERS_MESSAGE,
          );
        }
      }
      // Un disparador es solo un enlace (la FK al catálogo ya es CASCADE): el
      // conjunto se reemplaza y la auditoría guarda el antes
      // (HARD_DELETE_ALLOWLIST, src/shared/prisma/no-hard-delete.ts).
      // eslint-disable-next-line no-restricted-syntax
      await tx.recallTypeTrigger.deleteMany({
        where: {
          recallTypeId: id,
          catalogItemId: { notIn: [...catalogItemIds] },
        },
      });
      if (added.length > 0) {
        await tx.recallTypeTrigger.createMany({
          data: added.map((catalogItemId) => ({
            tenantId,
            recallTypeId: id,
            catalogItemId,
          })),
          skipDuplicates: true,
        });
      }
      const after = toTypeView(
        await tx.recallType.findUniqueOrThrow({
          where: { id },
          select: TYPE_VIEW_SELECT,
        }),
      );
      const event = configAuditEvent(audit, {
        ...RECALL_TYPE_AUDIT,
        action: 'UPDATE',
        resourceId: id,
        reason: 'RECALL_TYPE_TRIGGERS_UPDATED',
        before: { catalogItemIds: before.triggerCatalogItemIds },
        after: { catalogItemIds: after.triggerCatalogItemIds },
      });
      if (event) await writeAuditEvent(tx, event);
      return after;
    });
  }

  async findRecall(recallId: string): Promise<RecallRef | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // La sede sale de la MISMA consulta que la lista: quien no puede ver a
      // este paciente en la lista tampoco puede registrarle un contacto.
      const rows = await tx.$queryRaw<
        {
          id: string;
          patientId: string;
          kind: RecallKind | null;
          homeLocationId: string;
        }[]
      >`${this.recallFacts(
        new Date(),
        Prisma.sql`AND pr."id" = ${recallId}::uuid AND pa."deletedAt" IS NULL`,
      )}`;
      const row = rows[0];
      return row
        ? {
            id: row.id,
            patientId: row.patientId,
            kind: row.kind,
            locationId: row.homeLocationId,
          }
        : null;
    });
  }

  appointmentOfPatient(
    appointmentId: string,
    patientId: string,
  ): Promise<boolean> {
    return this.prisma.runWithTenant(async (tx) => {
      const found = await tx.appointment.findFirst({
        where: { id: appointmentId, patientId, deletedAt: null },
        select: { id: true },
      });
      return found !== null;
    });
  }

  createContact(data: NewRecallContact): Promise<RecallContactView> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.recallContact.create({
        data: { tenantId: this.tenantId(), ...data },
        select: CONTACT_SELECT,
      });
      return this.toContact(row, await this.staffNames(tx, [row.authorId]));
    });
  }

  staff(ids: readonly string[]): Promise<Map<string, StaffRef>> {
    return this.prisma.runWithTenant(async (tx) => {
      const names = await this.staffNames(tx, ids);
      return new Map(
        ids.map((id) => [id, { id, fullName: names.get(id) ?? null }]),
      );
    });
  }

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('Sin tenant en el contexto del request.');
    return tenantId;
  }

  /** Nombre de cada miembro de la clínica (bajo RLS), en una consulta. */
  private async staffNames(
    tx: Prisma.TransactionClient,
    userIds: readonly string[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const members = await tx.clinicMembership.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, user: { select: { fullName: true } } },
    });
    return new Map(members.map((m) => [m.userId, m.user.fullName]));
  }

  private toContact(
    row: ContactRow,
    names: Map<string, string>,
  ): RecallContactView {
    return {
      id: row.id,
      recallId: row.recallId,
      kind: row.recall.kind,
      recallTypeId: row.recall.recallTypeId,
      recallTypeName: row.recall.recallType.name,
      patientId: row.patientId,
      locationId: row.locationId,
      channel: row.channel,
      outcome: row.outcome,
      note: row.note,
      appointmentId: row.appointmentId,
      author: { id: row.authorId, fullName: names.get(row.authorId) ?? null },
      createdAt: row.createdAt,
    };
  }
}
