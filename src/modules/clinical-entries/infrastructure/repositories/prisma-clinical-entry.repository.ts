import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  ClinicalEntryRepository,
  CreateClinicalEntryRepoInput,
  ListClinicalEntriesParams,
} from '../../domain/ports/clinical-entry-repository.port';
import { ClinicalEntry } from '../../domain/entities/clinical-entry.entity';
import {
  ADDENDA_ORDER,
  mapAddendum,
} from './prisma-clinical-entry-addendum.repository';

type PrismaClinicalEntry = Prisma.ClinicalEntryGetPayload<{
  include: { addenda: true };
}>;

function mapToEntity(row: PrismaClinicalEntry): ClinicalEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    entryDate: row.entryDate,
    reason: row.reason,
    notes: row.notes,
    performedById: row.performedById,
    createdAt: row.createdAt,
    addenda: row.addenda.map(mapAddendum),
  };
}

@Injectable()
export class PrismaClinicalEntryRepository implements ClinicalEntryRepository {
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
   * uses to set `app.current_tenant` (see PrismaMedicalHistoryRepository /
   * PrismaDentalCatalogRepository for the same convention).
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async create(input: CreateClinicalEntryRepoInput): Promise<ClinicalEntry> {
    const tenantId = this.requireTenantId();

    // Append-only: this is a plain INSERT. There is no update/delete method
    // on this repository at all — immutability enforced at the interface
    // level, not just by convention.
    const row = await this.prisma.runWithTenant(async (tx) => {
      return tx.clinicalEntry.create({
        data: {
          tenantId,
          patientId: input.patientId,
          entryDate: input.entryDate ?? new Date(),
          reason: input.reason,
          notes: input.notes,
          performedById: input.performedById,
        },
        include: { addenda: true },
      });
    });
    return mapToEntity(row);
  }

  async listByPatient(
    patientId: string,
    params?: ListClinicalEntriesParams,
  ): Promise<ClinicalEntry[]> {
    const where: Prisma.ClinicalEntryWhereInput = {
      patientId,
      deletedAt: null,
      ...(params?.from || params?.to
        ? {
            entryDate: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
    };

    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.clinicalEntry.findMany({
        where,
        orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
        // DX-038: las adendas viajan con su evolución, en orden cronológico.
        include: { addenda: { orderBy: ADDENDA_ORDER } },
      });
      return rows.map(mapToEntity);
    });
  }
}
