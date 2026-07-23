import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  CreateToothRecordRepoInput,
  ToothRecordRepository,
} from '../../domain/ports/tooth-record-repository.port';
import { ToothRecord } from '../../domain/entities/tooth-record.entity';

type PrismaToothRecord = Prisma.ToothRecordGetPayload<Record<string, never>>;

function mapToEntity(row: PrismaToothRecord): ToothRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    toothNumber: row.toothNumber,
    // surfaces is a Postgres enum array column — Prisma already returns it
    // as ToothSurface[]; mapped through explicitly (not passed by
    // reference) so this stays an intentional projection, same convention
    // as every other field on this entity.
    surfaces: row.surfaces.map((surface) => surface),
    kind: row.kind,
    catalogItemId: row.catalogItemId,
    status: row.status,
    notes: row.notes,
    clinicalEntryId: row.clinicalEntryId,
    performedById: row.performedById,
    recordedAt: row.recordedAt,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaToothRecordRepository implements ToothRecordRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `tenantId` is NOT NULL at the DB level with no column default that
   * autofills from the RLS GUC, so — unlike a plain SELECT, which RLS
   * filters transparently — an INSERT still needs the app to supply it
   * explicitly. We never take it from the input (never from the client); we
   * read it from the same request-scoped context that `runWithTenant(fn)`
   * uses to set `app.current_tenant` (see PrismaClinicalEntryRepository /
   * PrismaMedicalHistoryRepository for the same convention).
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async create(input: CreateToothRecordRepoInput): Promise<ToothRecord> {
    const tenantId = this.requireTenantId();

    // Append-only: this is a plain INSERT. There is no update/delete method
    // on this repository at all — immutability enforced at the interface
    // level, not just by convention.
    const row = await this.prisma.runWithTenant(async (tx) => {
      return tx.toothRecord.create({
        data: {
          tenantId,
          patientId: input.patientId,
          toothNumber: input.toothNumber,
          surfaces: input.surfaces,
          kind: input.kind,
          catalogItemId: input.catalogItemId,
          status: input.status,
          notes: input.notes,
          clinicalEntryId: input.clinicalEntryId,
          performedById: input.performedById,
          recordedAt: input.recordedAt ?? new Date(),
        },
      });
    });
    return mapToEntity(row);
  }

  async listByPatient(patientId: string): Promise<ToothRecord[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.toothRecord.findMany({
        where: { patientId, deletedAt: null },
        orderBy: { recordedAt: 'asc' },
      });
      return rows.map(mapToEntity);
    });
  }

  async listByTooth(
    patientId: string,
    toothNumber: string,
  ): Promise<ToothRecord[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.toothRecord.findMany({
        where: { patientId, toothNumber, deletedAt: null },
        orderBy: { recordedAt: 'desc' },
      });
      return rows.map(mapToEntity);
    });
  }
}
