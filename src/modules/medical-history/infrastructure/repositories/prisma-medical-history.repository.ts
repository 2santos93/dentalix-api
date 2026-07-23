import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  MedicalHistoryRepository,
  MedicalHistoryVersionData,
} from '../../domain/ports/medical-history-repository.port';
import { MedicalHistory } from '../../domain/entities/medical-history.entity';

type PrismaMedicalHistoryVersion = Prisma.MedicalHistoryVersionGetPayload<
  Record<string, never>
>;

function mapToEntity(row: PrismaMedicalHistoryVersion): MedicalHistory {
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    version: row.version,
    allergies: row.allergies,
    chronicConditions: row.chronicConditions,
    currentMedications: row.currentMedications,
    habits: row.habits,
    medicalAlerts: row.medicalAlerts,
    notes: row.notes,
    createdById: row.createdById,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaMedicalHistoryRepository implements MedicalHistoryRepository {
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
   * uses to set `app.current_tenant` (see PrismaPatientRepository /
   * PrismaDentalCatalogRepository for the same convention).
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async getLatest(patientId: string): Promise<MedicalHistory | null> {
    const row = await this.prisma.runWithTenant(async (tx) => {
      return tx.medicalHistoryVersion.findFirst({
        where: { patientId, deletedAt: null },
        orderBy: { version: 'desc' },
      });
    });
    return row ? mapToEntity(row) : null;
  }

  async createVersion(
    patientId: string,
    data: MedicalHistoryVersionData,
    createdById?: string,
  ): Promise<MedicalHistory> {
    const tenantId = this.requireTenantId();

    const row = await this.prisma.runWithTenant(async (tx) => {
      // Append-only: NEVER update/delete an existing row. `findFirst` +
      // `create` run inside the same `runWithTenant` transaction, so the
      // version number is computed from a consistent snapshot; the previous
      // row is left completely untouched by this write (the partial unique
      // index (tenantId, patientId, version) WHERE deletedAt IS NULL is the
      // last-resort guard against a concurrent double-insert of the same
      // version).
      const latest = await tx.medicalHistoryVersion.findFirst({
        where: { patientId, deletedAt: null },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = (latest?.version ?? 0) + 1;

      return tx.medicalHistoryVersion.create({
        data: {
          tenantId,
          patientId,
          version,
          allergies: data.allergies,
          chronicConditions: data.chronicConditions,
          currentMedications: data.currentMedications,
          habits: data.habits,
          medicalAlerts: data.medicalAlerts,
          notes: data.notes,
          createdById,
        },
      });
    });
    return mapToEntity(row);
  }
}
