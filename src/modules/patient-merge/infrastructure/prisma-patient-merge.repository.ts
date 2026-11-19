import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type DocumentType } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import type { AuditEventDraft } from '../../audit/domain/audit-event';
import {
  countLivePublicLinks,
  revokeLivePublicLinks,
} from '../../patients/infrastructure/patient-public-links';
import { totalLivePublicLinks } from '../../patients/domain/live-public-links';
import { assertDocFree } from '../../patients/infrastructure/repositories/prisma-patient.repository';
import {
  defaultPhoneRegionIn,
  reconcilePatientPhoneE164,
} from '../../patients/infrastructure/phone-e164';
import {
  DUPLICATE_REASONS,
  MAX_DUPLICATE_GROUP_SIZE,
} from '../domain/duplicate-reasons';
import {
  MERGE_CATEGORIES,
  MERGE_CATEGORY_PRIMARY_TABLE,
  MERGE_TABLE_CATEGORY,
  type MergeCategory,
} from '../domain/merge-categories';
import {
  dx266Code,
  inactiveException,
  isMergeBlockerCode,
  mergeHttpError,
  MERGE_PATIENT_NOT_FOUND_MESSAGE,
  notMergedException,
  type MergeBlockerCode,
} from '../domain/merge-errors';
import {
  MERGE_FIELD_GROUPS,
  MERGE_FIELD_GROUP_NAMES,
  mergeFieldPatch,
  type MergeFieldColumn,
  type MergeFieldValues,
} from '../domain/merge-fields';
import type {
  DuplicatePair,
  DuplicatePatientSummary,
  ListDuplicatesParams,
  MergeInput,
  MergeLeftover,
  MergeLeftoversResult,
  MergePreview,
  MergeResult,
  MergeSide,
  PatientMergeRepository,
} from '../domain/patient-merge-repository.port';
import {
  phoneReviewOf,
  setPhoneReviewInTx,
} from '../../recall/infrastructure/recall-phone-review';

type Tx = Prisma.TransactionClient;

const FIELD_COLUMNS = [
  ...new Set(
    MERGE_FIELD_GROUP_NAMES.flatMap(
      (g) => MERGE_FIELD_GROUPS[g] as readonly MergeFieldColumn[],
    ),
  ),
];

const FIELD_SELECT = Object.fromEntries(
  FIELD_COLUMNS.map((c) => [c, true]),
) as Record<MergeFieldColumn, true>;

/** Lo que se cuenta de cada categoría en la vista previa (filas vivas). */
const CATEGORY_COUNTS: Record<
  Exclude<MergeCategory, 'other'>,
  (tx: Tx, patientId: string) => Promise<number>
> = {
  appointments: (tx, patientId) =>
    tx.appointment.count({ where: { patientId, deletedAt: null } }),
  clinicalEntries: (tx, patientId) =>
    tx.clinicalEntry.count({ where: { patientId } }),
  odontogram: (tx, patientId) => tx.toothRecord.count({ where: { patientId } }),
  periodontogram: (tx, patientId) =>
    tx.perioExam.count({ where: { patientId } }),
  anamnesis: (tx, patientId) =>
    tx.medicalHistoryVersion.count({ where: { patientId, deletedAt: null } }),
  consents: (tx, patientId) =>
    tx.patientConsent.count({ where: { patientId } }),
  documents: (tx, patientId) =>
    tx.patientDocument.count({ where: { patientId, voidedAt: null } }),
  prescriptions: (tx, patientId) =>
    tx.prescription.count({ where: { patientId } }),
  treatmentPlans: (tx, patientId) =>
    tx.treatmentPlan.count({ where: { patientId, deletedAt: null } }),
  payments: (tx, patientId) =>
    tx.payment.count({ where: { patientId, deletedAt: null } }),
  coverages: (tx, patientId) =>
    tx.patientCoverage.count({ where: { patientId, deletedAt: null } }),
  responsibleParties: (tx, patientId) =>
    tx.patientResponsibleParty.count({ where: { patientId, deletedAt: null } }),
  recalls: (tx, patientId) => tx.patientRecall.count({ where: { patientId } }),
};

interface PairRow {
  a: string | null;
  b: string | null;
  reasons: string[];
  total: bigint;
}

interface SummaryRow {
  id: string;
  patientCode: number;
  firstName: string;
  lastName: string;
  documentType: DocumentType;
  docTypeLabel: string | null;
  docNumber: string | null;
  birthDate: string | null;
  phone: string | null;
  email: string | null;
  createdAt: Date;
  lastAttentionAt: Date | null;
}

interface LeftoverRow {
  id: string;
  patientCode: number;
  firstName: string;
  lastName: string;
  mergedAt: Date;
  pending: Record<string, number>;
}

type MergeOutcome = {
  moved: Record<string, number>;
  resolved: Record<string, number>;
};

/** `{tabla: n}` → lista ordenada por tabla. */
function tableCounts(
  counts: Record<string, number>,
): { table: string; count: number }[] {
  return Object.entries(counts)
    .map(([table, count]) => ({ table, count: Number(count) }))
    .sort((x, y) => x.table.localeCompare(y.table));
}

/**
 * Por categoría de la vista previa, en su orden. `patients` (los recomendados
 * del absorbido, DX-172) y cualquier tabla sin categoría van a «otros».
 */
function categoryCounts(
  counts: Record<string, number>,
): { category: MergeCategory; count: number }[] {
  const totals = new Map<MergeCategory, number>();
  for (const [table, count] of Object.entries(counts)) {
    const category = MERGE_TABLE_CATEGORY[table] ?? 'other';
    totals.set(category, (totals.get(category) ?? 0) + Number(count));
  }
  return MERGE_CATEGORIES.filter((c) => totals.has(c)).map((category) => ({
    category,
    count: totals.get(category)!,
  }));
}

function civilDay(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/**
 * DX-266: detección de posibles duplicados, «No es duplicado», vista previa y
 * fusión. Todo bajo la RLS de la clínica (`runWithTenant`); la reasignación
 * la hace `dx_merge_patients` (SECURITY DEFINER), en la misma transacción que
 * la anulación de enlaces, la ficha elegida y la auditoría.
 */
@Injectable()
export class PrismaPatientMergeRepository implements PatientMergeRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  /**
   * Parejas por documento normalizado, nombre + nacimiento y teléfono +
   * nombre: cada motivo es UN GROUP BY sobre una clave normalizada (una
   * pasada por los pacientes vivos de la clínica, servida por sus índices
   * parciales), y solo se emparejan los de un mismo grupo (≤ 10). Nada de
   * comparar a cada paciente con todos.
   */
  async listDuplicates(
    params: ListDuplicatesParams,
  ): Promise<{ items: DuplicatePair[]; total: number }> {
    const tenantId = this.tenantId();
    const location = params.locationId ?? null;
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.$queryRaw<PairRow[]>`
        WITH live AS (
          SELECT p."id", p."docKey", p."birthDate", p."phoneTail",
                 p."firstName", p."lastName"
            FROM "patients" p
           WHERE p."tenantId" = ${tenantId}::uuid AND p."deletedAt" IS NULL
        ),
        groups AS (
          SELECT 'DOCUMENT'::text AS reason, array_agg(l."id" ORDER BY l."id") AS ids
            FROM live l
           WHERE l."docKey" IS NOT NULL AND l."docKey" <> ''
           GROUP BY l."docKey"
          HAVING count(*) BETWEEN 2 AND ${MAX_DUPLICATE_GROUP_SIZE}
          UNION ALL
          SELECT 'NAME_BIRTHDATE', array_agg(l."id" ORDER BY l."id")
            FROM live l
           WHERE l."birthDate" IS NOT NULL
           GROUP BY l."birthDate", dx_search_normalize(l."firstName" || ' ' || l."lastName")
          HAVING count(*) BETWEEN 2 AND ${MAX_DUPLICATE_GROUP_SIZE}
          UNION ALL
          SELECT 'PHONE_NAME', array_agg(l."id" ORDER BY l."id")
            FROM live l
           WHERE l."phoneTail" IS NOT NULL AND length(l."phoneTail") >= 7
           GROUP BY l."phoneTail",
                    split_part(dx_search_normalize(l."firstName"), ' ', 1),
                    split_part(dx_search_normalize(l."lastName"), ' ', 1)
          HAVING count(*) BETWEEN 2 AND ${MAX_DUPLICATE_GROUP_SIZE}
        ),
        pairs AS (
          SELECT a.id AS a, b.id AS b, array_agg(DISTINCT g.reason ORDER BY g.reason) AS reasons
            FROM groups g
           CROSS JOIN LATERAL unnest(g.ids) WITH ORDINALITY AS a(id, i)
           CROSS JOIN LATERAL unnest(g.ids) WITH ORDINALITY AS b(id, j)
           WHERE a.i < b.j
           GROUP BY a.id, b.id
        ),
        visible AS (
          SELECT p.* FROM pairs p
           WHERE NOT EXISTS (
                   SELECT 1 FROM "patient_duplicate_dismissals" d
                    WHERE d."tenantId" = ${tenantId}::uuid
                      AND d."patientAId" = p.a AND d."patientBId" = p.b)
             AND (${location}::uuid IS NULL
                  OR EXISTS (SELECT 1 FROM "appointments" ap
                              WHERE ap."tenantId" = ${tenantId}::uuid
                                AND ap."patientId" IN (p.a, p.b)
                                AND ap."locationId" = ${location}::uuid
                                AND ap."deletedAt" IS NULL)
                  OR EXISTS (SELECT 1 FROM "patient_ledgers" lg
                              WHERE lg."tenantId" = ${tenantId}::uuid
                                AND lg."patientId" IN (p.a, p.b)
                                AND lg."locationId" = ${location}::uuid))
        )
        -- Siempre una fila con el total, aunque la página quede vacía.
        SELECT pg.a, pg.b, pg.reasons, c.total
          FROM (SELECT count(*) AS total FROM visible) c
          LEFT JOIN LATERAL (
            SELECT v.a, v.b, v.reasons
              FROM visible v
             ORDER BY ('DOCUMENT' = ANY (v.reasons)) DESC, cardinality(v.reasons) DESC, v.a, v.b
             LIMIT ${params.take} OFFSET ${params.skip}
          ) pg ON true`;
      const total = Number(rows[0]?.total ?? 0);
      const page = rows.filter(
        (r): r is PairRow & { a: string; b: string } => r.a !== null,
      );
      if (page.length === 0) return { items: [], total };
      const ids = [...new Set(page.flatMap((r) => [r.a, r.b]))];
      const summaries = await this.summaries(tx, ids);
      const items = page.map((r) => ({
        patients: [summaries.get(r.a)!, summaries.get(r.b)!] as [
          DuplicatePatientSummary,
          DuplicatePatientSummary,
        ],
        reasons: DUPLICATE_REASONS.filter((reason) =>
          r.reasons.includes(reason),
        ),
      }));
      return { items, total };
    });
  }

  private async summaries(
    tx: Tx,
    ids: string[],
  ): Promise<Map<string, DuplicatePatientSummary>> {
    const rows = await tx.$queryRaw<SummaryRow[]>`
      SELECT p."id", p."patientCode", p."firstName", p."lastName",
             p."documentType", p."docTypeLabel", p."docNumber",
             to_char(p."birthDate", 'YYYY-MM-DD') AS "birthDate",
             p."phone", p."email", p."createdAt",
             p."last_attention_at" AS "lastAttentionAt"
        FROM "patients" p
       WHERE p."id" = ANY (${ids}::uuid[])`;
    return new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          patientCode: String(r.patientCode),
          firstName: r.firstName,
          lastName: r.lastName,
          documentType: r.documentType,
          docTypeLabel: r.docTypeLabel,
          docNumber: r.docNumber,
          birthDate: r.birthDate,
          phone: r.phone,
          email: r.email,
          createdAt: r.createdAt,
          lastAttentionAt: r.lastAttentionAt,
        },
      ]),
    );
  }

  /** Los dos vivos en la clínica (bajo RLS: de otra clínica no se ven). */
  private async liveCount(tx: Tx, ids: string[]): Promise<number> {
    return tx.patient.count({ where: { id: { in: ids }, deletedAt: null } });
  }

  async dismiss(
    patientIds: [string, string],
    ctx: AuditRequestContext,
  ): Promise<boolean> {
    const tenantId = this.tenantId();
    const [a, b] = patientIds;
    return this.prisma.runWithTenant(async (tx) => {
      if ((await this.liveCount(tx, [a, b])) !== 2) return false;
      const inserted = await tx.$executeRaw`
        INSERT INTO "patient_duplicate_dismissals"
               ("id", "tenantId", "patientAId", "patientBId", "dismissedById")
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${a}::uuid, ${b}::uuid,
                ${ctx.actor.userId}::uuid)
        ON CONFLICT ("tenantId", "patientAId", "patientBId") DO NOTHING`;
      // Ya descartada: nada que auditar (idempotente).
      if (inserted === 0) return true;
      for (const [patientId, otherPatientId] of [
        [a, b],
        [b, a],
      ]) {
        await writeAuditEvent(
          tx,
          this.draft(ctx, patientId, {
            reason: 'PATIENT_DUPLICATE_DISMISSED',
            params: { otherPatientId },
          }),
        );
      }
      return true;
    });
  }

  async preview(
    keptId: string,
    absorbedId: string,
    now: Date,
    ctx: AuditRequestContext,
  ): Promise<MergePreview | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const [kept, absorbed] = await Promise.all([
        this.side(tx, keptId),
        this.side(tx, absorbedId),
      ]);
      if (!kept || !absorbed) return null;
      const [{ blockers }] = await tx.$queryRaw<{ blockers: string[] }[]>`
        SELECT dx_patient_merge_blockers(${absorbedId}::uuid, ${keptId}::uuid) AS blockers`;
      const absorbedLiveLinks = await countLivePublicLinks(tx, {
        tenantId,
        patientId: absorbedId,
        now,
      });
      // Ver los datos de dos fichas es leerlas: como GET /patients/:id.
      for (const [patientId, otherPatientId] of [
        [keptId, absorbedId],
        [absorbedId, keptId],
      ]) {
        await writeAuditEvent(tx, {
          ...this.draft(ctx, patientId, {
            reason: 'PATIENT_MERGE_PREVIEW',
            params: { otherPatientId },
          }),
          action: 'VIEW',
        });
      }
      return {
        kept,
        absorbed,
        blockers: blockers.filter((code): code is MergeBlockerCode =>
          isMergeBlockerCode(code),
        ),
        absorbedLiveLinks: {
          ...absorbedLiveLinks,
          total: totalLivePublicLinks(absorbedLiveLinks),
        },
      };
    });
  }

  private async side(tx: Tx, id: string): Promise<MergeSide | null> {
    const patient = await tx.patient.findFirst({
      where: { id, deletedAt: null },
      select: {
        ...FIELD_SELECT,
        id: true,
        patientCode: true,
        createdAt: true,
        lastAttentionAt: true,
        city: { select: { name: true } },
      },
    });
    if (!patient) return null;
    const counts: MergeSide['counts'] = [];
    for (const category of MERGE_CATEGORIES) {
      if (category === 'other' || !MERGE_CATEGORY_PRIMARY_TABLE[category]) {
        continue;
      }
      counts.push({ category, count: await CATEGORY_COUNTS[category](tx, id) });
    }
    const fields = Object.fromEntries(
      FIELD_COLUMNS.map((c) => [
        c,
        c === 'birthDate' ? civilDay(patient.birthDate) : patient[c],
      ]),
    ) as MergeFieldValues;
    return {
      id: patient.id,
      patientCode: String(patient.patientCode),
      createdAt: patient.createdAt,
      lastAttentionAt: patient.lastAttentionAt,
      cityName: patient.city?.name ?? null,
      fields,
      counts,
    };
  }

  async merge(
    input: MergeInput,
    now: Date,
    ctx: AuditRequestContext,
  ): Promise<MergeResult> {
    const tenantId = this.tenantId();
    const { keptId, absorbedId } = input;
    return this.prisma.runWithTenant(async (tx) => {
      // Los dos bloqueados en orden de id, como hará dx_merge_patients: una
      // segunda fusión sobre cualquiera de los dos espera aquí y después ve
      // al absorbido retirado (409).
      const locked = await tx.$queryRaw<
        { id: string; deletedAt: Date | null }[]
      >`
        SELECT "id", "deletedAt" FROM "patients"
         WHERE "id" IN (${keptId}::uuid, ${absorbedId}::uuid)
         ORDER BY "id"
           FOR UPDATE`;
      if (locked.length !== 2) {
        throw new NotFoundException(MERGE_PATIENT_NOT_FOUND_MESSAGE);
      }
      if (locked.some((row) => row.deletedAt !== null)) {
        throw inactiveException();
      }
      const [keptRow, absorbedRow] = await Promise.all(
        [keptId, absorbedId].map((id) =>
          tx.patient.findUniqueOrThrow({ where: { id }, select: FIELD_SELECT }),
        ),
      );

      // DX-465 (ruling 4): la marca del teléfono del absorbido, antes de que
      // la fusión lo retire.
      const absorbedPhoneReview = await phoneReviewOf(tx, tenantId, absorbedId);

      // DX-461: los enlaces públicos vivos del absorbido se anulan (la
      // clínica los vuelve a enviar desde el conservado si hace falta).
      const revokedLinks = await revokeLivePublicLinks(tx, {
        tenantId,
        patientId: absorbedId,
        now,
        actorId: ctx.actor.userId,
      });

      let outcome: {
        moved: Record<string, number>;
        resolved: Record<string, number>;
      };
      try {
        const [row] = await tx.$queryRaw<{ result: typeof outcome }[]>`
          SELECT dx_merge_patients(${absorbedId}::uuid, ${keptId}::uuid,
                                   ${ctx.actor.userId}::uuid) AS result`;
        outcome = row.result;
      } catch (error) {
        const code = dx266Code(error);
        if (code) throw mergeHttpError(code);
        throw error;
      }

      // La ficha: los grupos elegidos del absorbido, ya retirado (su
      // documento ya no ocupa el del conservado).
      const { patch, groups } = mergeFieldPatch(
        keptRow,
        absorbedRow,
        input.choices,
      );
      if (groups.length > 0) {
        if (typeof patch.docNumber === 'string') {
          await assertDocFree(tx, tenantId, patch.docNumber, keptId);
        }
        await tx.patient.update({
          where: { id: keptId },
          data: patch as Prisma.PatientUncheckedUpdateInput,
        });
        if (typeof patch.phone === 'string') {
          // DX-465 (ruling 4): el número del absorbido llega con su marca de
          // «teléfono por revisar».
          if (absorbedPhoneReview) {
            await setPhoneReviewInTx(tx, tenantId, keptId, absorbedPhoneReview);
          }
          await reconcilePatientPhoneE164(
            tx,
            [keptId],
            await defaultPhoneRegionIn(tx, ctx.locationId),
          );
        }
      }

      for (const [patientId, otherPatientId, role] of [
        [keptId, absorbedId, 'KEPT'],
        [absorbedId, keptId, 'ABSORBED'],
      ] as const) {
        await writeAuditEvent(
          tx,
          this.draft(ctx, patientId, {
            reason: 'PATIENT_MERGED',
            ...(role === 'KEPT' && groups.length > 0
              ? { changedFields: groups }
              : {}),
            ...(role === 'ABSORBED' && totalLivePublicLinks(revokedLinks) > 0
              ? { revokedLinks }
              : {}),
            patientMerge: {
              role,
              otherPatientId,
              moved: outcome.moved,
              resolved: outcome.resolved,
            },
          }),
        );
      }

      return {
        patientId: keptId,
        absorbedPatientId: absorbedId,
        moved: Object.entries(outcome.moved)
          .map(([table, count]) => ({ table, count }))
          .sort((x, y) => x.table.localeCompare(y.table)),
        resolved: Object.entries(outcome.resolved)
          .map(([kind, count]) => ({ kind, count }))
          .sort((x, y) => x.kind.localeCompare(y.kind)),
        revokedLinks: {
          ...revokedLinks,
          total: totalLivePublicLinks(revokedLinks),
        },
        fieldsFromAbsorbed: groups,
      };
    });
  }

  /**
   * DX-266-bis: los absorbidos por `keptId` a los que les quedó algo. Primero
   * los fusionados en él (índice parcial de `mergedIntoId`); solo de esos se
   * cuentan las filas (`dx_patient_merge_pending`, la lista cerrada de la
   * fusión). Sin fusionados, una sola consulta.
   */
  async leftovers(keptId: string): Promise<MergeLeftover[] | null> {
    return this.prisma.runWithTenant(async (tx) => {
      if ((await this.liveCount(tx, [keptId])) !== 1) return null;
      const rows = await tx.$queryRaw<LeftoverRow[]>`
        SELECT p."id", p."patientCode", p."firstName", p."lastName",
               p."deletedAt" AS "mergedAt",
               dx_patient_merge_pending(p."id") AS "pending"
          FROM "patients" p
         WHERE p."mergedIntoId" = ${keptId}::uuid AND p."deletedAt" IS NOT NULL
         ORDER BY p."deletedAt", p."id"`;
      return rows
        .filter((r) => Object.keys(r.pending).length > 0)
        .map((r) => {
          const tables = tableCounts(r.pending);
          return {
            absorbedPatientId: r.id,
            patientCode: String(r.patientCode),
            firstName: r.firstName,
            lastName: r.lastName,
            mergedAt: r.mergedAt,
            tables,
            categories: categoryCounts(r.pending),
            total: tables.reduce((sum, t) => sum + t.count, 0),
          };
        });
    });
  }

  async moveLeftovers(
    absorbedId: string,
    now: Date,
    ctx: AuditRequestContext,
  ): Promise<MergeLeftoversResult> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const [target] = await tx.$queryRaw<{ mergedIntoId: string | null }[]>`
        SELECT "mergedIntoId" FROM "patients" WHERE "id" = ${absorbedId}::uuid`;
      if (!target) throw new NotFoundException(MERGE_PATIENT_NOT_FOUND_MESSAGE);
      if (!target.mergedIntoId) throw notMergedException();
      const keptId = target.mergedIntoId;
      // El orden de bloqueo de la fusión: el conservado y DESPUÉS el
      // absorbido (una fusión bloquea a su pareja y después, al reapuntar
      // `mergedIntoId`, a los absorbidos de los dos). Con una fusión del
      // conservado o con otra vuelta a la vez, se ponen en cola.
      await tx.$queryRaw`
        SELECT 1 FROM "patients" WHERE "id" = ${keptId}::uuid FOR UPDATE`;
      const [absorbedRow] = await tx.$queryRaw<
        { mergedIntoId: string | null }[]
      >`
        SELECT "mergedIntoId" FROM "patients"
         WHERE "id" = ${absorbedId}::uuid FOR UPDATE`;
      // Mientras esperaba, el conservado se fusionó con otro (el absorbido
      // ya apunta a ese): que recargue.
      if (absorbedRow?.mergedIntoId !== keptId) throw inactiveException();

      // Un enlace público creado tarde para el absorbido se anula, como en
      // la fusión (DX-461): se generó con la identidad del absorbido.
      const revokedLinks = await revokeLivePublicLinks(tx, {
        tenantId,
        patientId: absorbedId,
        now,
        actorId: ctx.actor.userId,
      });

      let outcome: MergeOutcome;
      try {
        const [row] = await tx.$queryRaw<{ result: MergeOutcome }[]>`
          SELECT dx_merge_patients_late(${absorbedId}::uuid,
                                        ${ctx.actor.userId}::uuid) AS result`;
        outcome = row.result;
      } catch (error) {
        const code = dx266Code(error);
        if (code) throw mergeHttpError(code);
        throw error;
      }

      // Nada que mover: nada que auditar (idempotente). Los recomendados
      // (DX-172) cuentan en `resolved` (referralsMoved).
      const changed =
        Object.keys(outcome.moved).length +
        Object.keys(outcome.resolved).length;
      if (changed > 0) {
        for (const [patientId, otherPatientId, role] of [
          [keptId, absorbedId, 'KEPT'],
          [absorbedId, keptId, 'ABSORBED'],
        ] as const) {
          await writeAuditEvent(
            tx,
            this.draft(ctx, patientId, {
              reason: 'PATIENT_MERGE_LEFTOVERS_MOVED',
              ...(role === 'ABSORBED' && totalLivePublicLinks(revokedLinks) > 0
                ? { revokedLinks }
                : {}),
              patientMerge: {
                role,
                otherPatientId,
                moved: outcome.moved,
                resolved: outcome.resolved,
              },
            }),
          );
        }
      }

      return {
        patientId: keptId,
        absorbedPatientId: absorbedId,
        moved: tableCounts(outcome.moved),
        resolved: Object.entries(outcome.resolved)
          .map(([kind, count]) => ({ kind, count }))
          .sort((x, y) => x.kind.localeCompare(y.kind)),
        revokedLinks: {
          ...revokedLinks,
          total: totalLivePublicLinks(revokedLinks),
        },
      };
    });
  }

  private draft(
    ctx: AuditRequestContext,
    patientId: string,
    metadata: Record<string, unknown>,
  ): AuditEventDraft {
    return {
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'UPDATE',
      resourceType: 'PATIENT',
      resourceId: patientId,
      patient: { kind: 'patient', id: patientId },
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata,
    };
  }
}
