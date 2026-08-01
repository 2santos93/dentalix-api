import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  MedicalHistoryRepository,
  MedicalHistoryVersionData,
} from '../../domain/ports/medical-history-repository.port';
import {
  MedicalHistory,
  Allergy,
  Condition,
  Medication,
  Habits,
  DentalHistory,
  Surgery,
  VitalSigns,
  SafetyFlags,
} from '../../domain/entities/medical-history.entity';
import { deriveSafetyFlags } from '../../domain/safety-flags';

type PrismaMedicalHistoryVersion = Prisma.MedicalHistoryVersionGetPayload<
  Record<string, never>
>;

const EMPTY_FLAGS: SafetyFlags = {
  embarazo: false,
  anticoagulantes: false,
  bifosfonatos: false,
  diabetes: false,
  profilaxisAntibiotica: false,
  alergiaAnestesico: false,
  alergiaPenicilina: false,
  alergiaLatex: false,
};

function mapToEntity(row: PrismaMedicalHistoryVersion): MedicalHistory {
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    version: row.version,
    allergies: (row.allergies as Allergy[] | null) ?? [],
    conditions: (row.conditions as Condition[] | null) ?? [],
    medications: (row.medications as Medication[] | null) ?? [],
    habits: (row.habits as Habits | null) ?? null,
    dentalHistory: (row.dentalHistory as DentalHistory | null) ?? null,
    surgeries: (row.surgeries as Surgery[] | null) ?? [],
    vitalSigns: (row.vitalSigns as VitalSigns | null) ?? null,
    familyHistory: row.familyHistory,
    notes: row.notes,
    safetyFlags: (row.safetyFlags as SafetyFlags | null) ?? EMPTY_FLAGS,
    hasCriticalAlert: row.hasCriticalAlert,
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
    const { safetyFlags, hasCriticalAlert } = deriveSafetyFlags(data);

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
          allergies: (data.allergies ?? []) as unknown as Prisma.InputJsonValue,
          conditions: (data.conditions ??
            []) as unknown as Prisma.InputJsonValue,
          medications: (data.medications ??
            []) as unknown as Prisma.InputJsonValue,
          habits: (data.habits ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          dentalHistory: (data.dentalHistory ??
            Prisma.JsonNull) as Prisma.InputJsonValue,
          surgeries: (data.surgeries ?? []) as unknown as Prisma.InputJsonValue,
          vitalSigns: (data.vitalSigns ??
            Prisma.JsonNull) as Prisma.InputJsonValue,
          familyHistory: data.familyHistory,
          notes: data.notes,
          safetyFlags: safetyFlags as unknown as Prisma.InputJsonValue,
          hasCriticalAlert,
          createdById,
        },
      });
    });
    return mapToEntity(row);
  }
}
