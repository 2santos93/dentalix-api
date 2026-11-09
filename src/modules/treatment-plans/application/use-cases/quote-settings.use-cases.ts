import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  isValidQuoteValidityDays,
  quoteSettingsCode,
  QUOTE_VALIDITY_DAYS_MESSAGE,
  type QuoteSettings,
} from '../../domain/quote-validity';
import {
  QUOTE_SETTINGS_REPOSITORY,
  type QuoteSettingsRepository,
} from '../../domain/ports/quote-settings-repository.port';

@Injectable()
export class GetQuoteSettingsUseCase {
  constructor(
    @Inject(QUOTE_SETTINGS_REPOSITORY)
    private readonly repo: QuoteSettingsRepository,
  ) {}

  execute(): Promise<QuoteSettings> {
    return this.repo.get();
  }
}

/**
 * Cambia cuántos días vale un presupuesto en la clínica (DX-379; solo ADMIN,
 * lo exige la ruta) y, si de verdad cambió, lo audita con el campo cambiado y
 * el antes y el después en códigos QT. Aplica a los presupuestos que se
 * emitan después (presentar, primera impresión): los ya emitidos guardan sus
 * fechas y no cambian.
 */
@Injectable()
export class UpdateQuoteSettingsUseCase {
  constructor(
    @Inject(QUOTE_SETTINGS_REPOSITORY)
    private readonly repo: QuoteSettingsRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  async execute(
    input: QuoteSettings,
    ctx: AuditRequestContext,
  ): Promise<QuoteSettings> {
    if (!isValidQuoteValidityDays(input.validityDays)) {
      throw new BadRequestException(QUOTE_VALIDITY_DAYS_MESSAGE);
    }
    const { before, after } = await this.repo.set({
      validityDays: input.validityDays,
    });
    // Como los ajustes de la receta: el evento va tras confirmar el cambio y
    // `record` nunca lanza (DX-009).
    if (before.validityDays !== after.validityDays) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        actor: {
          kind: 'user',
          userId: ctx.actor.userId,
          role: ctx.actor.role,
        },
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: null,
        patient: null,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: {
          reason: 'QUOTE_SETTINGS',
          changedFields: ['validityDays'],
          statusChange: {
            from: quoteSettingsCode(before),
            to: quoteSettingsCode(after),
          },
        },
      });
    }
    return after;
  }
}
