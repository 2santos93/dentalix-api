import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  EXCHANGE_RATE_SOURCES,
  EXCHANGE_RATE_SOURCE_MESSAGE,
  type ExchangeRateSource,
} from '../../domain/exchange-rate-source';
import {
  CLINIC_EXCHANGE_SETTINGS_REPOSITORY,
  type ClinicExchangeSettingsRepository,
} from '../../domain/ports/clinic-exchange-settings-repository.port';

export interface ExchangeRateSettings {
  source: ExchangeRateSource;
}

@Injectable()
export class GetExchangeRateSettingsUseCase {
  constructor(
    @Inject(CLINIC_EXCHANGE_SETTINGS_REPOSITORY)
    private readonly settings: ClinicExchangeSettingsRepository,
  ) {}

  async execute(): Promise<ExchangeRateSettings> {
    return { source: await this.settings.getSource() };
  }
}

/**
 * Cambia la fuente de la tasa de la clínica (solo ADMIN, lo exige la ruta)
 * y, si de verdad cambió, lo audita con el antes y el después. Aplica desde la
 * siguiente lectura de tasas: nadie la guarda en caché. Los abonos ya
 * cobrados no se tocan (congelar su tasa es DX-375).
 */
@Injectable()
export class UpdateExchangeRateSettingsUseCase {
  constructor(
    @Inject(CLINIC_EXCHANGE_SETTINGS_REPOSITORY)
    private readonly settings: ClinicExchangeSettingsRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  async execute(
    input: ExchangeRateSettings,
    ctx: AuditRequestContext,
  ): Promise<ExchangeRateSettings> {
    if (!EXCHANGE_RATE_SOURCES.includes(input.source)) {
      throw new BadRequestException(EXCHANGE_RATE_SOURCE_MESSAGE);
    }
    const { before, after } = await this.settings.setSource(input.source);
    // Como la mayoría de edad y la receta: el evento va tras confirmar el
    // cambio y `record` nunca lanza (DX-009).
    if (before !== after) {
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
          reason: 'EXCHANGE_RATE_SOURCE',
          statusChange: { from: before, to: after },
        },
      });
    }
    return { source: after };
  }
}
