import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { SafetyFlags } from '../../domain/entities/medical-history.entity';
import { lockPatientAnamnesis } from './anamnesis-lock';
import type {
  AnamnesisConfirmation,
  AnamnesisLastReview,
  AnamnesisReviewState,
  MedicalAlertsRepository,
} from '../../domain/ports/medical-alerts-repository.port';

interface ReviewStateRow {
  patientId: string;
  versionId: string;
  safetyFlags: SafetyFlags | null;
  hasCriticalAlert: boolean;
  createdAt: Date;
  alertAllergens: string[];
  lastConfirmedAt: Date | null;
}

@Injectable()
export class PrismaMedicalAlertsRepository implements MedicalAlertsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async reviewStates(
    patientIds: readonly string[],
  ): Promise<Map<string, AnamnesisReviewState>> {
    const out = new Map<string, AnamnesisReviewState>();
    if (patientIds.length === 0) return out;
    // Una sola consulta bajo RLS. La versión vigente sale del índice parcial
    // mhv_tenant_patient_version_key y la última confirmación de
    // medical_history_reviews_tenant_patient_idx (LIMIT 1 por paciente). De
    // las alergias solo se leen los alérgenos marcados como alerta, para
    // decidir la bandera genérica: no salen de aquí.
    // El tenant también va explícito en cada LATERAL: el plan usa los índices
    // por (tenantId, patientId) sin depender de cómo se escriba la política.
    const tenantId = this.tenantId();
    const rows = await this.prisma.runWithTenant(
      (tx) => tx.$queryRaw<ReviewStateRow[]>`
        SELECT p.id::text AS "patientId",
               v.id::text AS "versionId",
               v."safetyFlags",
               v."hasCriticalAlert",
               v."createdAt",
               COALESCE(
                 (SELECT array_agg(a->>'alergeno')
                    FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(v."allergies") = 'array'
                           THEN v."allergies" ELSE '[]'::jsonb END
                    ) AS a
                   WHERE a->>'esAlerta' = 'true'),
                 ARRAY[]::text[]
               ) AS "alertAllergens",
               r."reviewedAt" AS "lastConfirmedAt"
          FROM unnest(${[...patientIds]}::uuid[]) AS p(id)
          JOIN LATERAL (
            SELECT mhv.id, mhv."safetyFlags", mhv."hasCriticalAlert",
                   mhv."createdAt", mhv."allergies"
              FROM "medical_history_versions" mhv
             WHERE mhv."tenantId" = ${tenantId}::uuid
               AND mhv."patientId" = p.id
               AND mhv."deletedAt" IS NULL
             ORDER BY mhv."version" DESC
             LIMIT 1
          ) v ON true
          LEFT JOIN LATERAL (
            SELECT mhr."reviewedAt"
              FROM "medical_history_reviews" mhr
             WHERE mhr."tenantId" = ${tenantId}::uuid
               AND mhr."patientId" = p.id
             ORDER BY mhr."reviewedAt" DESC
             LIMIT 1
          ) r ON true`,
    );
    for (const row of rows) {
      out.set(row.patientId, {
        snapshot: {
          versionId: row.versionId,
          safetyFlags: row.safetyFlags,
          hasCriticalAlert: row.hasCriticalAlert,
          alertAllergens: row.alertAllergens,
          createdAt: row.createdAt,
        },
        lastConfirmedAt: row.lastConfirmedAt,
      });
    }
    return out;
  }

  async getValidityMonths(): Promise<number> {
    // `tenants` es global (sin RLS): siempre por el id del contexto.
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: { anamnesisValidityMonths: true },
    });
    return tenant.anamnesisValidityMonths;
  }

  async setValidityMonths(
    months: number,
  ): Promise<{ before: number; after: number }> {
    const id = this.tenantId();
    // Lectura con la fila bloqueada y escritura en la misma transacción.
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ months: number }[]>`
        SELECT "anamnesisValidityMonths" AS months
          FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const tenant = await tx.tenant.update({
        where: { id },
        data: { anamnesisValidityMonths: months },
        select: { anamnesisValidityMonths: true },
      });
      return { before: locked.months, after: tenant.anamnesisValidityMonths };
    });
  }

  async lastReview(patientId: string): Promise<AnamnesisLastReview | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const version = await tx.medicalHistoryVersion.findFirst({
        where: { patientId, deletedAt: null },
        orderBy: { version: 'desc' },
        select: { createdAt: true, createdById: true },
      });
      if (!version) return null;
      const confirmation = await tx.medicalHistoryReview.findFirst({
        where: { patientId },
        orderBy: { reviewedAt: 'desc' },
        select: { reviewedAt: true, reviewedById: true },
      });
      const review: {
        kind: AnamnesisLastReview['kind'];
        at: Date;
        by: string | null;
      } =
        confirmation && confirmation.reviewedAt > version.createdAt
          ? {
              kind: 'NO_CHANGES',
              at: confirmation.reviewedAt,
              by: confirmation.reviewedById,
            }
          : { kind: 'UPDATED', at: version.createdAt, by: version.createdById };
      return {
        kind: review.kind,
        at: review.at,
        byName: review.by ? await this.memberName(tx, review.by) : null,
      };
    });
  }

  async createConfirmation(input: {
    patientId: string;
    reviewedById: string;
  }): Promise<AnamnesisConfirmation | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Mismo candado por paciente que el alta de una versión (ver
      // PrismaMedicalHistoryRepository.createVersion): si alguien guarda una
      // versión a la vez, esta espera y confirma la que quede vigente.
      await lockPatientAnamnesis(tx, tenantId, input.patientId);
      const version = await tx.medicalHistoryVersion.findFirst({
        where: { patientId: input.patientId, deletedAt: null },
        orderBy: { version: 'desc' },
        select: { id: true },
      });
      if (!version) return null;
      const row = await tx.medicalHistoryReview.create({
        data: {
          tenantId,
          patientId: input.patientId,
          medicalHistoryVersionId: version.id,
          reviewedById: input.reviewedById,
          locationId: this.tenantContext.getLocationId() ?? null,
        },
      });
      return {
        id: row.id,
        patientId: row.patientId,
        medicalHistoryVersionId: row.medicalHistoryVersionId,
        reviewedById: row.reviewedById,
        reviewedByName: await this.memberName(tx, row.reviewedById),
        locationId: row.locationId,
        reviewedAt: row.reviewedAt,
      };
    });
  }

  /**
   * Nombre de un miembro de ESTA clínica (la membresía va bajo RLS): un id de
   * otra clínica no da nombre. Sin filtrar `deletedAt`: si dejó la clínica, la
   * revisión sigue siendo suya.
   */
  private async memberName(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<string | null> {
    const membership = await tx.clinicMembership.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { user: { select: { fullName: true } } },
    });
    return membership?.user.fullName ?? null;
  }
}
