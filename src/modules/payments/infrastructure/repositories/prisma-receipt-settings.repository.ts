import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../../audit/domain/config-audit';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import type {
  LocationReceiptLegendView,
  ReceiptSettingsRepository,
} from '../../domain/ports/receipt-settings-repository.port';
import type {
  ClinicReceiptSettings,
  LocationReceiptLegend,
} from '../../domain/receipt-settings';

interface ClinicRow {
  receiptTitle: string | null;
  receiptLegend: string | null;
}

interface LocationRow {
  id: string;
  name: string;
  isActive: boolean;
  receiptLegendOverride: boolean;
  receiptLegend: string | null;
}

const toClinic = (row: ClinicRow): ClinicReceiptSettings => ({
  title: row.receiptTitle,
  legend: row.receiptLegend,
});

const toLocation = (row: LocationRow): LocationReceiptLegendView => ({
  locationId: row.id,
  name: row.name,
  isActive: row.isActive,
  override: row.receiptLegendOverride,
  legend: row.receiptLegend,
});

/**
 * DX-515. `tenants` es global (sin RLS): siempre por el id del contexto.
 * `locations` sí tiene RLS: se lee y se escribe dentro de `runWithTenant`, así
 * que una sede de otra clínica no se ve (404). El evento de auditoría va en la
 * MISMA transacción que el cambio, con el antes y el después (DX-360).
 */
@Injectable()
export class PrismaReceiptSettingsRepository implements ReceiptSettingsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async getClinic(): Promise<ClinicReceiptSettings> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: { receiptTitle: true, receiptLegend: true },
    });
    return toClinic(tenant);
  }

  listLocations(): Promise<LocationReceiptLegendView[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.location.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          name: true,
          isActive: true,
          receiptLegendOverride: true,
          receiptLegend: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map(toLocation);
    });
  }

  setClinic(
    next: ClinicReceiptSettings,
    ctx: AuditRequestContext,
  ): Promise<ClinicReceiptSettings> {
    const id = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Lectura con la fila bloqueada y escritura en la misma transacción:
      // dos cambios simultáneos se ordenan y cada uno audita su antes real.
      const [locked] = await tx.$queryRaw<ClinicRow[]>`
        SELECT "receiptTitle", "receiptLegend"
          FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const updated = await tx.tenant.update({
        where: { id },
        data: { receiptTitle: next.title, receiptLegend: next.legend },
        select: { receiptTitle: true, receiptLegend: true },
      });
      const event = configAuditEvent(ctx, {
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: id,
        reason: 'RECEIPT_SETTINGS',
        before: {
          receiptTitle: locked.receiptTitle,
          receiptLegend: locked.receiptLegend,
        },
        after: {
          receiptTitle: updated.receiptTitle,
          receiptLegend: updated.receiptLegend,
        },
      });
      if (event) await writeAuditEvent(tx, event);
      return toClinic(updated);
    });
  }

  setLocation(
    locationId: string,
    next: LocationReceiptLegend,
    ctx: AuditRequestContext,
  ): Promise<LocationReceiptLegendView | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const [locked] = await tx.$queryRaw<LocationRow[]>`
        SELECT "id", "name", "isActive", "receiptLegendOverride", "receiptLegend"
          FROM "locations"
         WHERE "id" = ${locationId}::uuid AND "deletedAt" IS NULL
         FOR UPDATE`;
      if (!locked) return null;
      const updated = await tx.location.update({
        where: { id: locationId },
        data: {
          receiptLegendOverride: next.override,
          // Sin leyenda propia, la columna vuelve a NULL (CHECK de la BD).
          receiptLegend: next.override ? next.legend : null,
        },
        select: {
          id: true,
          name: true,
          isActive: true,
          receiptLegendOverride: true,
          receiptLegend: true,
        },
      });
      const event = configAuditEvent(ctx, {
        action: 'UPDATE',
        resourceType: 'LOCATION',
        resourceId: locationId,
        locationId,
        reason: 'RECEIPT_LEGEND',
        before: {
          receiptLegendOverride: locked.receiptLegendOverride,
          receiptLegend: locked.receiptLegend,
        },
        after: {
          receiptLegendOverride: updated.receiptLegendOverride,
          receiptLegend: updated.receiptLegend,
        },
      });
      if (event) await writeAuditEvent(tx, event);
      return toLocation(updated);
    });
  }
}
