import { Injectable } from '@nestjs/common';
import { PerioExamStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveReferenceLocation } from '../../../../shared/locations/reference-location';
import type { PerioExamRecord } from '../../domain/entities/perio-exam.entity';
import {
  PERIO_FLAG,
  decodeFlags,
  encodeFlags,
} from '../../domain/perio-measures';
import type {
  CreatePerioExamRepoInput,
  PerioExamRepository,
  PerioExamSummaryRow,
  PerioWriteResult,
  SavePerioMeasuresRepoInput,
} from '../../domain/ports/perio-exam-repository.port';

const EXAM_INCLUDE = {
  provider: { select: { fullName: true } },
  siteMeasures: true,
  toothMeasures: true,
} satisfies Prisma.PerioExamInclude;

type ExamRow = Prisma.PerioExamGetPayload<{ include: typeof EXAM_INCLUDE }>;

/** `examDate` es DATE: Prisma lo trae como medianoche UTC. */
function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function fromDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Fila del resumen (DX-103): cabecera, autor y conteos, sin medidas. */
interface SummarySqlRow {
  id: string;
  tenantId: string;
  patientId: string;
  providerId: string;
  providerName: string;
  examDate: Date;
  notes: string | null;
  status: PerioExamStatus;
  finalizedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  sitesExamined: number;
  bleedingSites: number;
  plaqueSites: number;
  sites4mmOrMore: number;
  sites6mmOrMore: number;
}

function mapRow(row: ExamRow): PerioExamRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    providerId: row.providerId,
    providerName: row.provider.fullName,
    examDate: toDateOnly(row.examDate),
    notes: row.notes,
    status: row.status,
    finalizedAt: row.finalizedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sites: row.siteMeasures.map((m) => ({
      toothFdi: m.toothFdi,
      site: m.site,
      probingMm: m.probingMm,
      recessionMm: m.recessionMm,
      furcation: m.furcation,
      ...decodeFlags(m.flags),
    })),
    teeth: row.toothMeasures.map((t) => ({
      toothFdi: t.toothFdi,
      mobility: t.mobility,
      skipped: t.skipped,
    })),
  };
}

/**
 * Todo corre bajo `runWithTenant` (RLS): un examen o un paciente de otra
 * clínica no existen para esta. Además cada consulta va acotada por
 * `patientId`, así que un examen de OTRO paciente de la misma clínica tampoco
 * se alcanza por la ruta de este.
 */
@Injectable()
export class PrismaPerioExamRepository implements PerioExamRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  /** Sede activa (cabecera validada por el guard) → su zona; sin sede, la de la principal (R6). */
  async clinicTimeZone(): Promise<string> {
    const locationId = this.tenantContext.getLocationId() ?? null;
    const tenantId = this.requireTenantId();
    const reference = await this.prisma.runWithTenant((tx) =>
      resolveReferenceLocation(tx, tenantId, locationId),
    );
    return reference.timeZone;
  }

  /**
   * DX-103: el histórico sale de UNA consulta que pagina los exámenes y
   * cuenta sus sitios en la base; las medidas no viajan (antes se traían las
   * 224 celdas de cada examen para calcular cuatro números). Los porcentajes
   * los redondea el caso de uso con la misma función que el detalle.
   *
   * La página se corta ANTES de contar (CTE con LIMIT) y cada conteo baja por
   * el único (tenantId, examId, …) de las medidas. `tenantId` va explícito,
   * del contexto, para que el índice del histórico sirva además de la RLS.
   */
  async listSummaries(
    patientId: string,
    limit: number,
  ): Promise<PerioExamSummaryRow[]> {
    const tenantId = this.requireTenantId();
    const rows = await this.prisma.runWithTenant(
      (tx) => tx.$queryRaw<SummarySqlRow[]>`
        WITH page AS (
          SELECT e."id", e."tenantId", e."patientId", e."providerId",
                 e."examDate", e."notes", e."status"::text AS "status",
                 e."finalizedAt", e."createdAt", e."updatedAt"
          FROM "public"."perio_exams" e
          WHERE e."tenantId" = ${tenantId}::uuid
            AND e."patientId" = ${patientId}::uuid
            AND e."deletedAt" IS NULL
          ORDER BY e."examDate" DESC, e."createdAt" DESC
          LIMIT ${limit}
        )
        SELECT p.*, u."fullName" AS "providerName",
               c."sitesExamined", c."bleedingSites", c."plaqueSites",
               c."sites4mmOrMore", c."sites6mmOrMore"
        FROM page p
        JOIN "public"."users" u ON u."id" = p."providerId"
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS "sitesExamined",
                 count(*) FILTER (WHERE s."flags" & ${PERIO_FLAG.BOP} <> 0)::int AS "bleedingSites",
                 count(*) FILTER (WHERE s."flags" & ${PERIO_FLAG.PLAQ} <> 0)::int AS "plaqueSites",
                 count(*) FILTER (WHERE s."probingMm" >= 4)::int AS "sites4mmOrMore",
                 count(*) FILTER (WHERE s."probingMm" >= 6)::int AS "sites6mmOrMore"
          FROM "public"."perio_site_measures" s
          WHERE s."tenantId" = p."tenantId"
            AND s."examId" = p."id"
            -- Examinado = con sondaje o alguna marca (flags 0..15).
            AND (s."probingMm" IS NOT NULL OR s."flags" <> 0)
            -- Fuera los dientes omitidos (ausentes / no sondables).
            AND NOT EXISTS (
              SELECT 1 FROM "public"."perio_tooth_measures" t
              WHERE t."tenantId" = s."tenantId"
                AND t."examId" = s."examId"
                AND t."toothFdi" = s."toothFdi"
                AND t."skipped"
            )
        ) c
        ORDER BY p."examDate" DESC, p."createdAt" DESC`,
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      patientId: row.patientId,
      providerId: row.providerId,
      providerName: row.providerName,
      examDate: toDateOnly(row.examDate),
      notes: row.notes,
      status: row.status,
      finalizedAt: row.finalizedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      counts: {
        sitesExamined: row.sitesExamined,
        bleedingSites: row.bleedingSites,
        plaqueSites: row.plaqueSites,
        sites4mmOrMore: row.sites4mmOrMore,
        sites6mmOrMore: row.sites6mmOrMore,
      },
    }));
  }

  async findById(
    patientId: string,
    id: string,
  ): Promise<PerioExamRecord | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.perioExam.findFirst({
        where: { id, patientId, deletedAt: null },
        include: EXAM_INCLUDE,
      }),
    );
    return row ? mapRow(row) : null;
  }

  async findLatest(patientId: string): Promise<PerioExamRecord | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.perioExam.findFirst({
        where: { patientId, deletedAt: null },
        orderBy: [{ examDate: 'desc' }, { createdAt: 'desc' }],
        include: EXAM_INCLUDE,
      }),
    );
    return row ? mapRow(row) : null;
  }

  async create(input: CreatePerioExamRepoInput): Promise<PerioExamRecord> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      tx.perioExam.create({
        data: {
          tenantId,
          patientId: input.patientId,
          providerId: input.providerId,
          examDate: fromDateOnly(input.examDate),
          notes: input.notes,
          toothMeasures: {
            // tenantId lo hereda del examen (FK compuesta).
            create: input.skippedTeeth.map((toothFdi) => ({
              toothFdi,
              skipped: true,
            })),
          },
        },
        include: EXAM_INCLUDE,
      }),
    );
    return mapRow(row);
  }

  /**
   * Una transacción y, como mucho, seis sentencias (DX-103): BEGIN,
   * set_config del tenant, el UPDATE de guarda, un INSERT … ON CONFLICT por
   * tabla y COMMIT. Antes era un upsert por celda: ≈227 idas y vueltas, que con
   * la latencia de un enlace inestable rozaban el tope de 5 s de la
   * transacción.
   *
   * El UPDATE condicionado a DRAFT bloquea la fila del examen, así que un
   * «finalizar» u otro guardado concurrente espera y no puede colarse entre la
   * comprobación y la escritura. Después, upsert por conjuntos (unnest de
   * arrays paralelos) por (diente, sitio); una celda que no cambia no se
   * reescribe (`IS DISTINCT FROM`). Nada se borra en duro: una celda limpiada
   * queda como fila vacía, que el caso de uso no muestra ni cuenta.
   *
   * El trigger de inmutabilidad de DX-007 sigue en pie como red: es de fila y
   * mira el examen por su PK (`perio_exams_pkey`), una búsqueda de coste fijo
   * que no depende de las estadísticas.
   */
  async saveMeasures(
    patientId: string,
    id: string,
    input: SavePerioMeasuresRepoInput,
  ): Promise<PerioWriteResult> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const guard = await this.lockDraft(tx, patientId, id, {
        updatedAt: new Date(),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });
      if (guard !== 'ok') return guard;

      const { sites, teeth } = input;
      if (sites.length > 0) {
        await tx.$executeRaw`
          INSERT INTO "public"."perio_site_measures" AS m
            ("id", "tenantId", "examId", "toothFdi", "site",
             "probingMm", "recessionMm", "furcation", "flags")
          SELECT gen_random_uuid(), ${tenantId}::uuid, ${id}::uuid,
                 u."toothFdi", u."site"::"public"."PerioSite",
                 u."probingMm", u."recessionMm", u."furcation", u."flags"
          FROM unnest(
            ${sites.map((s) => s.toothFdi)}::smallint[],
            ${sites.map((s) => s.site)}::text[],
            ${sites.map((s) => s.probingMm)}::smallint[],
            ${sites.map((s) => s.recessionMm)}::smallint[],
            ${sites.map((s) => s.furcation)}::smallint[],
            ${sites.map((s) => encodeFlags(s))}::smallint[]
          ) AS u("toothFdi", "site", "probingMm", "recessionMm", "furcation", "flags")
          ON CONFLICT ("tenantId", "examId", "toothFdi", "site") DO UPDATE SET
            "probingMm" = EXCLUDED."probingMm",
            "recessionMm" = EXCLUDED."recessionMm",
            "furcation" = EXCLUDED."furcation",
            "flags" = EXCLUDED."flags"
          WHERE (m."probingMm", m."recessionMm", m."furcation", m."flags")
            IS DISTINCT FROM
            (EXCLUDED."probingMm", EXCLUDED."recessionMm", EXCLUDED."furcation", EXCLUDED."flags")`;
      }
      if (teeth.length > 0) {
        await tx.$executeRaw`
          INSERT INTO "public"."perio_tooth_measures" AS m
            ("id", "tenantId", "examId", "toothFdi", "mobility", "skipped")
          SELECT gen_random_uuid(), ${tenantId}::uuid, ${id}::uuid,
                 u."toothFdi", u."mobility", u."skipped"
          FROM unnest(
            ${teeth.map((t) => t.toothFdi)}::smallint[],
            ${teeth.map((t) => t.mobility)}::smallint[],
            ${teeth.map((t) => t.skipped)}::boolean[]
          ) AS u("toothFdi", "mobility", "skipped")
          ON CONFLICT ("tenantId", "examId", "toothFdi") DO UPDATE SET
            "mobility" = EXCLUDED."mobility",
            "skipped" = EXCLUDED."skipped"
          WHERE (m."mobility", m."skipped")
            IS DISTINCT FROM (EXCLUDED."mobility", EXCLUDED."skipped")`;
      }
      return 'ok';
    });
  }

  finalize(patientId: string, id: string, at: Date): Promise<PerioWriteResult> {
    return this.prisma.runWithTenant((tx) =>
      this.lockDraft(tx, patientId, id, {
        status: PerioExamStatus.FINAL,
        finalizedAt: at,
      }),
    );
  }

  /** Borrado blando, solo de un DRAFT. */
  deleteDraft(patientId: string, id: string): Promise<PerioWriteResult> {
    return this.prisma.runWithTenant((tx) =>
      this.lockDraft(tx, patientId, id, { deletedAt: new Date() }),
    );
  }

  /** UPDATE solo si sigue en DRAFT; si no, distingue 404 de 409. */
  private async lockDraft(
    tx: Prisma.TransactionClient,
    patientId: string,
    id: string,
    data: Prisma.PerioExamUpdateManyMutationInput,
  ): Promise<PerioWriteResult> {
    const updated = await tx.perioExam.updateMany({
      where: { id, patientId, deletedAt: null, status: PerioExamStatus.DRAFT },
      data,
    });
    if (updated.count > 0) return 'ok';
    return this.missingOrFinal(tx, patientId, id);
  }

  private async missingOrFinal(
    tx: Prisma.TransactionClient,
    patientId: string,
    id: string,
  ): Promise<PerioWriteResult> {
    const exam = await tx.perioExam.findFirst({
      where: { id, patientId, deletedAt: null },
      select: { status: true },
    });
    return exam ? 'final' : 'not_found';
  }
}
