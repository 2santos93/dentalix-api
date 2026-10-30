import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { civilDateIn } from '../../../../shared/time/civil-day';
import {
  BASE_CURRENCY,
  EXCHANGE_RATE_SOURCES,
  EXCHANGE_RATE_SOURCE_MESSAGE,
  type ExchangeRateSource,
} from '../../domain/exchange-rate-source';
import {
  CLINIC_EXCHANGE_SETTINGS_REPOSITORY,
  type ClinicExchangeSettings,
  type ClinicExchangeSettingsRepository,
} from '../../domain/ports/clinic-exchange-settings-repository.port';
import { EXCHANGE_RATE_CLOCK } from './manual-exchange-rates.use-cases';
import { ExchangeSourceChangeHooks } from '../exchange-source-change-hooks';

export interface ExchangeRateSettings extends ClinicExchangeSettings {
  /** Moneda base de todas las tasas (unidades de cada moneda por 1 de ella). */
  baseCurrency: string;
}

const withBase = (settings: ClinicExchangeSettings): ExchangeRateSettings => ({
  source: settings.source,
  manualSince: settings.manualSince,
  baseCurrency: BASE_CURRENCY,
});

@Injectable()
export class GetExchangeRateSettingsUseCase {
  constructor(
    @Inject(CLINIC_EXCHANGE_SETTINGS_REPOSITORY)
    private readonly settings: ClinicExchangeSettingsRepository,
  ) {}

  async execute(): Promise<ExchangeRateSettings> {
    return withBase(await this.settings.get());
  }
}

/**
 * Cambia la fuente de la tasa de la clínica (solo ADMIN, lo exige la ruta)
 * y, si de verdad cambió, lo audita con el antes y el después.
 *
 * Pasar a MANUAL fija `manualSince` = hoy en la sede principal: la tasa
 * manual rige desde ese día y los anteriores siguen con la automática, así
 * que los saldos de antes del cambio no se mueven. Guardar MANUAL otra vez
 * conserva el día. Volver a AUTOMATIC lo limpia.
 *
 * DX-375 (BE-047): antes de cambiar la fuente se congela la tasa de todos los
 * abonos de la clínica que la esperaban, con la fuente de ANTES
 * (`ExchangeSourceChangeHooks`): un abono ya cobrado, también uno de hoy
 * anterior al cambio o de una sede con otra zona, conserva su tasa. Los que
 * siguen sin tasa la tomarán de la fuente nueva. Si congelar falla, la fuente
 * no cambia.
 */
@Injectable()
export class UpdateExchangeRateSettingsUseCase {
  constructor(
    @Inject(CLINIC_EXCHANGE_SETTINGS_REPOSITORY)
    private readonly settings: ClinicExchangeSettingsRepository,
    private readonly audit: RecordAuditEventUseCase,
    @Inject(EXCHANGE_RATE_CLOCK)
    private readonly now: () => Date,
    private readonly hooks: ExchangeSourceChangeHooks,
  ) {}

  async execute(
    input: { source: ExchangeRateSource },
    ctx: AuditRequestContext,
  ): Promise<ExchangeRateSettings> {
    if (!EXCHANGE_RATE_SOURCES.includes(input.source)) {
      throw new BadRequestException(EXCHANGE_RATE_SOURCE_MESSAGE);
    }
    // Solo hace falta la zona al elegir MANUAL: una clínica sin sedes puede
    // seguir guardando AUTOMATIC.
    const today =
      input.source === 'MANUAL'
        ? civilDateIn(this.now(), await this.settings.principalTimeZone())
        : null;
    if ((await this.settings.get()).source !== input.source) {
      await this.hooks.beforeSourceChange();
    }
    const { before, after } = await this.settings.set((current) =>
      input.source === 'MANUAL'
        ? {
            source: 'MANUAL',
            manualSince:
              current.source === 'MANUAL' && current.manualSince
                ? current.manualSince
                : today,
          }
        : { source: 'AUTOMATIC', manualSince: null },
    );
    // Como la mayoría de edad y la receta: el evento va tras confirmar el
    // cambio y `record` nunca lanza (DX-009).
    if (before.source !== after.source) {
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
          statusChange: { from: before.source, to: after.source },
        },
      });
    }
    return withBase(after);
  }
}
