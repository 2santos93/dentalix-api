import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { PrescriptionSettingsRepository } from '../../domain/ports/prescription-settings-repository.port';
import type { PrescriptionSettings } from '../../domain/prescription-settings';

const SETTINGS_SELECT = {
  prescriptionPrintQuantityInWords: true,
  prescriptionRequireClinicalRecordNumber: true,
  prescriptionValidityDays: true,
} as const;

interface SettingsRow {
  prescriptionPrintQuantityInWords: boolean;
  prescriptionRequireClinicalRecordNumber: boolean;
  prescriptionValidityDays: number;
}

const toSettings = (row: SettingsRow): PrescriptionSettings => ({
  printQuantityInWords: row.prescriptionPrintQuantityInWords,
  requireClinicalRecordNumber: row.prescriptionRequireClinicalRecordNumber,
  validityDays: row.prescriptionValidityDays,
});

@Injectable()
export class PrismaPrescriptionSettingsRepository implements PrescriptionSettingsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async get(): Promise<PrescriptionSettings> {
    // `tenants` es global (sin RLS): siempre por el id del contexto, sin
    // runWithTenant, como la mayoría de edad (DX-328).
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: SETTINGS_SELECT,
    });
    return toSettings(tenant);
  }

  async set(
    next: PrescriptionSettings,
  ): Promise<{ before: PrescriptionSettings; after: PrescriptionSettings }> {
    const id = this.tenantId();
    // Lectura con la fila bloqueada y escritura en la misma transacción.
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<SettingsRow[]>`
        SELECT "prescriptionPrintQuantityInWords",
               "prescriptionRequireClinicalRecordNumber",
               "prescriptionValidityDays"
          FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const tenant = await tx.tenant.update({
        where: { id },
        data: {
          prescriptionPrintQuantityInWords: next.printQuantityInWords,
          prescriptionRequireClinicalRecordNumber:
            next.requireClinicalRecordNumber,
          prescriptionValidityDays: next.validityDays,
        },
        select: SETTINGS_SELECT,
      });
      return { before: toSettings(locked), after: toSettings(tenant) };
    });
  }
}
