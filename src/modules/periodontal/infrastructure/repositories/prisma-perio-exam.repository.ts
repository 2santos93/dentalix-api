import { Injectable } from '@nestjs/common';
import { PerioExamStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { PerioExamRecord } from '../../domain/entities/perio-exam.entity';
import { decodeFlags, encodeFlags } from '../../domain/perio-measures';
import type {
  CreatePerioExamRepoInput,
  PerioExamRepository,
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

  async listByPatient(patientId: string): Promise<PerioExamRecord[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.perioExam.findMany({
        where: { patientId, deletedAt: null },
        orderBy: [{ examDate: 'desc' }, { createdAt: 'desc' }],
        include: EXAM_INCLUDE,
      }),
    );
    return rows.map(mapRow);
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
   * Una transacción: el UPDATE condicionado a DRAFT bloquea la fila del
   * examen, así que un «finalizar» concurrente espera y no puede colarse entre
   * la comprobación y la escritura. Después, upsert por (diente, sitio). Nada
   * se borra en duro: una celda limpiada queda como fila vacía, que el caso de
   * uso no muestra ni cuenta.
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

      for (const s of input.sites) {
        const values = {
          probingMm: s.probingMm,
          recessionMm: s.recessionMm,
          furcation: s.furcation,
          flags: encodeFlags(s),
        };
        await tx.perioSiteMeasure.upsert({
          where: {
            tenantId_examId_toothFdi_site: {
              tenantId,
              examId: id,
              toothFdi: s.toothFdi,
              site: s.site,
            },
          },
          create: {
            tenantId,
            examId: id,
            toothFdi: s.toothFdi,
            site: s.site,
            ...values,
          },
          update: values,
        });
      }
      for (const t of input.teeth) {
        const values = { mobility: t.mobility, skipped: t.skipped };
        await tx.perioToothMeasure.upsert({
          where: {
            tenantId_examId_toothFdi: {
              tenantId,
              examId: id,
              toothFdi: t.toothFdi,
            },
          },
          create: { tenantId, examId: id, toothFdi: t.toothFdi, ...values },
          update: values,
        });
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
