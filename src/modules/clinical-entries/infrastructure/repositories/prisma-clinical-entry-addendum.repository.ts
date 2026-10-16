import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  ClinicalEntryAddendumRepository,
  CreateClinicalEntryAddendumRepoInput,
} from '../../domain/ports/clinical-entry-addendum-repository.port';
import { ClinicalEntryAddendum } from '../../domain/entities/clinical-entry-addendum.entity';

type PrismaAddendum = Prisma.ClinicalEntryAddendumGetPayload<
  Record<string, never>
>;

export function mapAddendum(row: PrismaAddendum): ClinicalEntryAddendum {
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    clinicalEntryId: row.clinicalEntryId,
    reason: row.reason,
    text: row.text,
    authorId: row.authorId,
    createdAt: row.createdAt,
  };
}

/** Orden cronológico estable de las adendas (la BD fija `createdAt`). */
export const ADDENDA_ORDER: Prisma.ClinicalEntryAddendumOrderByWithRelationInput[] =
  [{ createdAt: 'asc' }, { id: 'asc' }];

@Injectable()
export class PrismaClinicalEntryAddendumRepository implements ClinicalEntryAddendumRepository {
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

  async entryExists(patientId: string, entryId: string): Promise<boolean> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.clinicalEntry.findFirst({
        where: { id: entryId, patientId, deletedAt: null },
        select: { id: true },
      }),
    );
    return row !== null;
  }

  async create(
    input: CreateClinicalEntryAddendumRepoInput,
  ): Promise<ClinicalEntryAddendum> {
    const tenantId = this.requireTenantId();
    // Append-only: un INSERT. `createdAt` lo sobrescribe el trigger
    // `clinical_entry_addenda_server_timestamp` con la hora del servidor.
    const row = await this.prisma.runWithTenant((tx) =>
      tx.clinicalEntryAddendum.create({
        data: {
          tenantId,
          patientId: input.patientId,
          clinicalEntryId: input.clinicalEntryId,
          reason: input.reason,
          text: input.text,
          authorId: input.authorId,
        },
      }),
    );
    return mapAddendum(row);
  }

  async listByEntry(
    patientId: string,
    entryId: string,
  ): Promise<ClinicalEntryAddendum[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.clinicalEntryAddendum.findMany({
        where: { patientId, clinicalEntryId: entryId },
        orderBy: ADDENDA_ORDER,
      }),
    );
    return rows.map(mapAddendum);
  }
}
