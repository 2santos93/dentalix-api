import { Injectable } from '@nestjs/common';
import { ClinicRole, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { locationRegionalOrNull } from '../../../shared/locations/location-regional';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import { auditDraftFromContext } from '../../audit/domain/audit-request-context';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import type {
  ClinicExportErrorCode,
  ClinicExportRecord,
} from '../domain/clinic-export';
import type { ExportRow } from '../domain/csv-format';
import { EXPORT_CATALOG, pageQuery } from '../domain/export-catalog';
import type {
  ClinicAdmin,
  ClinicExportRepository,
  CompletedExport,
  DownloadOutcome,
  InTx,
  RequestOutcome,
  StartedExport,
} from '../domain/ports/clinic-export-repository.port';

const ACTIVE = ['PENDING', 'RUNNING'] as const;

/** El SQL de cada fichero del catálogo, calculado una vez. */
const PAGE_SQL: ReadonlyMap<string, string> = new Map(
  EXPORT_CATALOG.map((table) => [table.file, pageQuery(table)]),
);

const RECORD_SELECT = {
  id: true,
  status: true,
  requestedById: true,
  requestedAt: true,
  startedAt: true,
  completedAt: true,
  errorCode: true,
  sizeBytes: true,
  fileCount: true,
  rowCounts: true,
  downloadExpiresAt: true,
  downloadedAt: true,
  downloadedById: true,
  fileDeletedAt: true,
} satisfies Prisma.ClinicExportSelect;

type RecordRow = Prisma.ClinicExportGetPayload<{
  select: typeof RECORD_SELECT;
}>;

function rowCountsOf(
  value: Prisma.JsonValue | null,
): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [file, n] of Object.entries(value)) {
    if (typeof n === 'number') out[file] = n;
  }
  return out;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/** Recuentos del ZIP para la auditoría (nunca su contenido). */
function exportCounts(row: {
  sizeBytes: bigint | null;
  fileCount: number | null;
  rowCounts: Prisma.JsonValue | null;
}) {
  const counts = rowCountsOf(row.rowCounts) ?? {};
  return {
    sizeBytes: Number(row.sizeBytes ?? 0),
    fileCount: row.fileCount ?? 0,
    totalRows: Object.values(counts).reduce((a, b) => a + b, 0),
  };
}

@Injectable()
export class PrismaClinicExportRepository implements ClinicExportRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('Exportación sin clínica en el contexto');
    return tenantId;
  }

  async isActiveAdmin(userId: string): Promise<boolean> {
    const tenantId = this.tenantId();
    const membership = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.clinicMembership.findFirst({
        where: {
          tenantId,
          userId,
          role: ClinicRole.ADMIN,
          deletedAt: null,
          user: { deletedAt: null },
        },
        select: { id: true },
      }),
    );
    return membership !== null;
  }

  async request(
    ctx: AuditRequestContext,
    staleBefore: Date,
    afterInsert: (
      exportId: string,
      tx: Prisma.TransactionClient,
    ) => Promise<void>,
  ): Promise<RequestOutcome> {
    const tenantId = this.tenantId();
    try {
      return await this.prisma.runWithTenant(tenantId, async (tx) => {
        // Una en curso que lleva horas: su trabajo murió sin cerrarla. Se
        // cierra para que la clínica no quede bloqueada con 409 para siempre.
        await tx.clinicExport.updateMany({
          where: {
            tenantId,
            status: { in: [...ACTIVE] },
            requestedAt: { lt: staleBefore },
          },
          data: {
            status: 'FAILED',
            errorCode: 'STALE' satisfies ClinicExportErrorCode,
            completedAt: new Date(),
          },
        });
        const created = await tx.clinicExport.create({
          data: { tenantId, requestedById: ctx.actor.userId },
          select: { id: true },
        });
        await afterInsert(created.id, tx);
        await writeAuditEvent(
          tx,
          auditDraftFromContext(
            // La exportación es de TODA la clínica: sin sede.
            { ...ctx, locationId: null },
            {
              action: 'CREATE',
              resourceType: 'CLINIC_EXPORT',
              resourceId: created.id,
              metadata: { reason: 'CLINIC_EXPORT_REQUESTED' },
            },
          ),
        );
        return { kind: 'CREATED' as const, id: created.id };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { kind: 'IN_PROGRESS' };
      throw error;
    }
  }

  async list(limit: number): Promise<ClinicExportRecord[]> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const rows: RecordRow[] = await tx.clinicExport.findMany({
        where: { tenantId },
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        take: limit,
        select: RECORD_SELECT,
      });
      const userIds = [
        ...new Set(
          rows.flatMap((r) =>
            r.downloadedById
              ? [r.requestedById, r.downloadedById]
              : [r.requestedById],
          ),
        ),
      ];
      // Solo nombres de miembros de ESTA clínica (membresías bajo RLS).
      const members = await tx.clinicMembership.findMany({
        where: { tenantId, userId: { in: userIds } },
        select: { userId: true, user: { select: { fullName: true } } },
      });
      const names = new Map(members.map((m) => [m.userId, m.user.fullName]));
      return rows.map((r): ClinicExportRecord => ({
        id: r.id,
        status: r.status,
        requestedById: r.requestedById,
        requestedByName: names.get(r.requestedById) ?? null,
        requestedAt: r.requestedAt,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        errorCode: r.errorCode,
        sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
        fileCount: r.fileCount,
        rowCounts: rowCountsOf(r.rowCounts),
        downloadExpiresAt: r.downloadExpiresAt,
        downloadedAt: r.downloadedAt,
        downloadedByName: r.downloadedById
          ? (names.get(r.downloadedById) ?? null)
          : null,
        fileDeletedAt: r.fileDeletedAt,
      }));
    });
  }

  async consumeDownload(
    id: string,
    ctx: AuditRequestContext,
    now: Date,
  ): Promise<DownloadOutcome> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      // Un solo uso SIN carreras: dos clics a la vez, solo uno cambia la fila.
      const consumed = await tx.clinicExport.updateMany({
        where: {
          id,
          tenantId,
          status: 'READY',
          downloadedAt: null,
          fileDeletedAt: null,
          downloadExpiresAt: { gt: now },
        },
        data: { downloadedAt: now, downloadedById: ctx.actor.userId },
      });
      const row = await tx.clinicExport.findFirst({
        where: { id, tenantId },
        select: { ...RECORD_SELECT, fileKey: true },
      });
      if (!row) return { kind: 'NOT_FOUND' };
      if (consumed.count === 0) {
        if (row.status === 'FAILED') return { kind: 'FAILED' };
        if (row.status !== 'READY') return { kind: 'NOT_READY' };
        if (row.downloadedAt) return { kind: 'DOWNLOADED' };
        return { kind: 'EXPIRED' };
      }
      if (!row.fileKey || row.sizeBytes === null || !row.completedAt) {
        // El CHECK de READY lo impide; defensa en profundidad.
        throw new Error('Exportación READY sin fichero');
      }
      await writeAuditEvent(
        tx,
        auditDraftFromContext(
          { ...ctx, locationId: null },
          {
            action: 'EXPORT',
            resourceType: 'CLINIC_EXPORT',
            resourceId: id,
            metadata: {
              reason: 'CLINIC_EXPORT_DOWNLOADED',
              clinicExport: exportCounts(row),
            },
          },
        ),
      );
      return {
        kind: 'OK',
        fileKey: row.fileKey,
        sizeBytes: Number(row.sizeBytes),
        completedAt: row.completedAt,
      };
    });
  }

  async start(id: string, now: Date): Promise<StartedExport | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const moved = await tx.clinicExport.updateMany({
        where: { id, tenantId, status: { in: [...ACTIVE] } },
        data: { status: 'RUNNING', startedAt: now },
      });
      if (moved.count === 0) return null;
      return tx.clinicExport.findFirstOrThrow({
        where: { id, tenantId },
        select: { requestedById: true, requestedAt: true },
      });
    });
  }

  async complete(
    id: string,
    data: CompletedExport,
    afterUpdate: InTx,
  ): Promise<boolean> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const done = await tx.clinicExport.updateMany({
        where: { id, tenantId, status: 'RUNNING' },
        data: {
          status: 'READY',
          fileKey: data.fileKey,
          sizeBytes: BigInt(data.sizeBytes),
          fileCount: data.fileCount,
          rowCounts: data.rowCounts,
          completedAt: data.completedAt,
          downloadExpiresAt: data.downloadExpiresAt,
        },
      });
      if (done.count === 0) return false;
      await afterUpdate(tx);
      return true;
    });
  }

  async fail(
    id: string,
    code: ClinicExportErrorCode,
    now: Date,
  ): Promise<void> {
    const tenantId = this.tenantId();
    await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.clinicExport.updateMany({
        where: { id, tenantId, status: { in: [...ACTIVE] } },
        data: { status: 'FAILED', errorCode: code, completedAt: now },
      }),
    );
  }

  async fileToPurge(id: string): Promise<string | null> {
    const tenantId = this.tenantId();
    const row = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.clinicExport.findFirst({
        where: { id, tenantId, fileDeletedAt: null },
        select: { fileKey: true },
      }),
    );
    return row?.fileKey ?? null;
  }

  async markFileDeleted(id: string, now: Date): Promise<void> {
    const tenantId = this.tenantId();
    await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.clinicExport.updateMany({
        where: { id, tenantId, fileDeletedAt: null },
        data: { fileDeletedAt: now },
      }),
    );
  }

  async activeAdmins(): Promise<ClinicAdmin[]> {
    const tenantId = this.tenantId();
    const rows = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.clinicMembership.findMany({
        where: {
          tenantId,
          role: ClinicRole.ADMIN,
          deletedAt: null,
          user: { deletedAt: null },
        },
        select: {
          userId: true,
          user: { select: { fullName: true, email: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map((r) => ({
      userId: r.userId,
      fullName: r.user.fullName,
      email: r.user.email,
    }));
  }

  async clinic() {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId, deletedAt: null },
        select: { name: true },
      });
      if (!tenant) return null;
      const location = await tx.location.findFirst({
        where: { tenantId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { timeZone: true, locale: true, hourCycle: true },
      });
      return { name: tenant.name, region: locationRegionalOrNull(location) };
    });
  }

  async page(
    file: string,
    afterId: string | null,
    limit: number,
  ): Promise<ExportRow[]> {
    const tenantId = this.tenantId();
    // El SQL sale SOLO del catálogo (constante, precalculado al cargar el
    // módulo): quien llama elige el fichero, nunca el texto. Clínica, cursor
    // y tamaño van como parámetros. Una transacción corta por página.
    const sql = PAGE_SQL.get(file);
    if (!sql) throw new Error(`Fichero de exportación desconocido: ${file}`);
    return this.prisma.runWithTenant(tenantId, (tx) =>
      tx.$queryRawUnsafe<ExportRow[]>(sql, tenantId, afterId, limit),
    );
  }
}
