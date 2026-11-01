import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  readCurrencyTexts,
  type CurrencyTexts,
} from '../../../../shared/format/currency-text';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../../audit/domain/config-audit';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import { currencyTextsForAudit } from '../../domain/clinic-currency-texts';
import type { ClinicCurrencyTextsRepository } from '../../domain/ports/clinic-currency-texts-repository.port';

/**
 * DX-517. `tenants` es global (sin RLS): siempre por el id del contexto. El
 * evento de auditoría va en la MISMA transacción que el cambio, con el antes
 * y el después (DX-360); sin cambio, sin evento.
 */
@Injectable()
export class PrismaClinicCurrencyTextsRepository implements ClinicCurrencyTextsRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async get(): Promise<CurrencyTexts> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: { currencyTexts: true },
    });
    return readCurrencyTexts(tenant.currencyTexts);
  }

  set(next: CurrencyTexts, ctx: AuditRequestContext): Promise<CurrencyTexts> {
    const id = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Fila bloqueada: dos cambios simultáneos se ordenan y cada uno audita su antes real.
      const [locked] = await tx.$queryRaw<{ currencyTexts: unknown }[]>`
        SELECT "currencyTexts" FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const updated = await tx.tenant.update({
        where: { id },
        data: { currencyTexts: next },
        select: { currencyTexts: true },
      });
      const before = readCurrencyTexts(locked.currencyTexts);
      const after = readCurrencyTexts(updated.currencyTexts);
      const event = configAuditEvent(ctx, {
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: id,
        reason: 'CURRENCY_TEXTS',
        before: { currencyTexts: currencyTextsForAudit(before) },
        after: { currencyTexts: currencyTextsForAudit(after) },
      });
      if (event) await writeAuditEvent(tx, event);
      return after;
    });
  }
}
