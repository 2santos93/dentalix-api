import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../../audit/domain/config-audit';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import type { SlotOfferSettingsRepository } from '../../domain/ports/slot-offer-settings-repository.port';
import type { StoredSlotOfferSettings } from '../../domain/slot-offer-link';

interface SettingsRow {
  slotOfferExpiryLeadMinutes: number | null;
  slotOfferMinLeadMinutes: number;
}

function toSettings(row: SettingsRow): StoredSlotOfferSettings {
  return {
    expiryLeadMinutes: row.slotOfferExpiryLeadMinutes,
    minLeadMinutes: row.slotOfferMinLeadMinutes,
  };
}

const SETTINGS_SELECT = {
  slotOfferExpiryLeadMinutes: true,
  slotOfferMinLeadMinutes: true,
} as const;

/**
 * Ajustes de la oferta de hueco por enlace (DX-448): columnas de `tenants`,
 * siempre por el id de la clínica del contexto (la fila de otra clínica no
 * se nombra nunca).
 */
@Injectable()
export class PrismaSlotOfferSettingsRepository implements SlotOfferSettingsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async get(): Promise<StoredSlotOfferSettings> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: SETTINGS_SELECT,
    });
    return toSettings(tenant);
  }

  async set(
    next: StoredSlotOfferSettings,
    ctx: AuditRequestContext,
  ): Promise<{
    before: StoredSlotOfferSettings;
    after: StoredSlotOfferSettings;
  }> {
    const id = this.tenantId();
    // Lectura con la fila bloqueada, escritura y evento en la misma
    // transacción (y con la clínica en el contexto de RLS: audit_events la
    // exige), como los ajustes de la tasa (DX-384).
    return this.prisma.runWithTenant(id, async (tx) => {
      const [locked] = await tx.$queryRaw<SettingsRow[]>`
        SELECT "slotOfferExpiryLeadMinutes", "slotOfferMinLeadMinutes"
          FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const before = toSettings(locked);
      const tenant = await tx.tenant.update({
        where: { id },
        data: {
          slotOfferExpiryLeadMinutes: next.expiryLeadMinutes,
          slotOfferMinLeadMinutes: next.minLeadMinutes,
        },
        select: SETTINGS_SELECT,
      });
      const after = toSettings(tenant);
      // DX-363: un ajuste de TODA la clínica no lleva la sede activa de quien
      // lo cambió. `null` antes = el valor de la instalación.
      const event = configAuditEvent(ctx, {
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: id,
        reason: 'SLOT_OFFER_SETTINGS',
        locationId: null,
        before: { ...before },
        after: { ...after },
      });
      if (event) await writeAuditEvent(tx, event);
      return { before, after };
    });
  }
}
