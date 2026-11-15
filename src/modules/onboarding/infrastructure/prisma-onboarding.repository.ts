import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { OnboardingFacts } from '../domain/onboarding-steps';
import type { OnboardingRepository } from '../domain/ports/onboarding-repository.port';

interface FactsRow {
  dismissedAt: Date | null;
  businessHours: boolean;
  appointmentTypes: boolean;
  catalogPrices: boolean;
  staff: boolean;
  firstAppointment: boolean;
  patientImport: boolean;
}

/**
 * DX-020. Una sola consulta con un EXISTS por paso (cada uno para en la
 * primera fila), dentro de `runWithTenant`: RLS deja ver solo la clínica del
 * contexto y, además, cada subconsulta filtra por su `tenantId` para usar los
 * índices que empiezan por él. `tenants` es global (sin RLS): se lee y se
 * escribe por el id del contexto, nunca por uno de la petición.
 * Criterio de cada paso: `../domain/onboarding-steps.ts`.
 */
@Injectable()
export class PrismaOnboardingRepository implements OnboardingRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async facts(): Promise<OnboardingFacts> {
    const id = this.tenantId();
    const rows = await this.prisma.runWithTenant(
      (tx) => tx.$queryRaw<FactsRow[]>`
        SELECT
          t."onboardingDismissedAt" AS "dismissedAt",
          EXISTS (
            SELECT 1
              FROM "location_schedules" s
              JOIN "locations" l
                ON l."tenantId" = s."tenantId" AND l."id" = s."locationId"
             WHERE s."tenantId" = ${id}::uuid
               AND s."deletedAt" IS NULL
               AND l."deletedAt" IS NULL
               AND EXISTS (
                 SELECT 1 FROM "location_schedule_ranges" r
                  WHERE r."tenantId" = s."tenantId"
                    AND r."scheduleId" = s."id"
                    AND r."deletedAt" IS NOT NULL)
          ) AS "businessHours",
          EXISTS (
            SELECT 1 FROM "appointment_types"
             WHERE "tenantId" = ${id}::uuid
               AND "deletedAt" IS NULL AND "active"
          ) AS "appointmentTypes",
          (EXISTS (
             SELECT 1 FROM "dental_catalog_items"
              WHERE "tenantId" = ${id}::uuid
                AND "deletedAt" IS NULL
                AND "kind" = 'PROCEDURE'
                AND "defaultPrice" IS NOT NULL)
           OR EXISTS (
             SELECT 1
               FROM "price_list_items" i
               JOIN "price_lists" p
                 ON p."tenantId" = i."tenantId" AND p."id" = i."priceListId"
              WHERE i."tenantId" = ${id}::uuid AND p."deletedAt" IS NULL)
          ) AS "catalogPrices",
          (EXISTS (
             SELECT 1 FROM "clinic_invitations"
              WHERE "tenantId" = ${id}::uuid
                AND "deletedAt" IS NULL AND "revokedAt" IS NULL)
           OR (SELECT count(*) FROM (
                 SELECT 1 FROM "clinic_memberships"
                  WHERE "tenantId" = ${id}::uuid AND "deletedAt" IS NULL
                  LIMIT 2) m) >= 2
          ) AS "staff",
          EXISTS (
            SELECT 1 FROM "appointments"
             WHERE "tenantId" = ${id}::uuid AND "deletedAt" IS NULL
          ) AS "firstAppointment",
          EXISTS (
            SELECT 1 FROM "patient_import_batches"
             WHERE "tenantId" = ${id}::uuid AND "status" = 'COMPLETED'
          ) AS "patientImport"
        FROM "tenants" t
        WHERE t."id" = ${id}::uuid`,
    );
    const row = rows[0];
    if (!row) throw new Error('Tenant not found');
    return {
      dismissedAt: row.dismissedAt,
      done: {
        BUSINESS_HOURS: row.businessHours,
        APPOINTMENT_TYPES: row.appointmentTypes,
        CATALOG_PRICES: row.catalogPrices,
        STAFF: row.staff,
        FIRST_APPOINTMENT: row.firstAppointment,
        PATIENT_IMPORT: row.patientImport,
      },
    };
  }

  async dismiss(): Promise<void> {
    const id = this.tenantId();
    // Sin auditoría: no es un ajuste de la clínica, solo esconde una ayuda del
    // panel. Idempotente: el segundo descarte no mueve la fecha.
    await this.prisma.runWithTenant((tx) =>
      tx.tenant.updateMany({
        where: { id, onboardingDismissedAt: null },
        data: { onboardingDismissedAt: new Date() },
      }),
    );
  }
}
