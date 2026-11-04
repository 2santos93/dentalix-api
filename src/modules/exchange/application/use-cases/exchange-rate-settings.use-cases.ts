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
import {
  MANUAL_RATE_MAX_AGE_MESSAGE,
  isValidManualRateMaxAge,
} from '../../domain/manual-rate-fallback';
import { EXCHANGE_RATE_CLOCK } from './manual-exchange-rates.use-cases';
import { ExchangeSourceChangeHooks } from '../exchange-source-change-hooks';

export const EXCHANGE_SETTINGS_EMPTY_MESSAGE =
  'Indica la fuente de la tasa, el plazo de la última tasa registrada o los dos.';

export interface ExchangeRateSettings extends ClinicExchangeSettings {
  /** Moneda base de todas las tasas (unidades de cada moneda por 1 de ella). */
  baseCurrency: string;
}

const withBase = (settings: ClinicExchangeSettings): ExchangeRateSettings => ({
  source: settings.source,
  manualSince: settings.manualSince,
  manualRateMaxAgeDays: settings.manualRateMaxAgeDays,
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
 * siguen sin tasa la toman después según la fuente nueva: con MANUAL, los de
 * un día desde `manualSince` de la manual de su día, y los de un día anterior
 * de la automática o, si el proveedor no tiene la de su día, de la manual de
 * ese día como tasa de respaldo (DX-402). Si congelar falla, la fuente no
 * cambia.
 *
 * DX-384: también cambia `manualRateMaxAgeDays` (0..30): hasta cuántos días
 * de antigüedad puede tener la última tasa manual que sustituye a la de un
 * día sin tasa. Cualquiera de los dos campos puede ir solo; al menos uno. El
 * evento del plazo (antes y después) lo escribe el repositorio en la misma
 * transacción; si cambia, los abonos aplazados «sin tasa» se intentan ya.
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
    input: { source?: ExchangeRateSource; manualRateMaxAgeDays?: number },
    ctx: AuditRequestContext,
  ): Promise<ExchangeRateSettings> {
    const { source, manualRateMaxAgeDays: maxAge } = input;
    if (source === undefined && maxAge === undefined) {
      throw new BadRequestException(EXCHANGE_SETTINGS_EMPTY_MESSAGE);
    }
    if (source !== undefined && !EXCHANGE_RATE_SOURCES.includes(source)) {
      throw new BadRequestException(EXCHANGE_RATE_SOURCE_MESSAGE);
    }
    if (maxAge !== undefined && !isValidManualRateMaxAge(maxAge)) {
      throw new BadRequestException(MANUAL_RATE_MAX_AGE_MESSAGE);
    }
    // Solo hace falta la zona al elegir MANUAL: una clínica sin sedes puede
    // seguir guardando AUTOMATIC.
    const today =
      source === 'MANUAL'
        ? civilDateIn(this.now(), await this.settings.principalTimeZone())
        : null;
    if (source !== undefined && (await this.settings.get()).source !== source) {
      await this.hooks.beforeSourceChange();
    }
    const { before, after } = await this.settings.set((current) => {
      const days = maxAge ?? current.manualRateMaxAgeDays;
      if (source === undefined)
        return { ...current, manualRateMaxAgeDays: days };
      return source === 'MANUAL'
        ? {
            source: 'MANUAL',
            manualSince:
              current.source === 'MANUAL' && current.manualSince
                ? current.manualSince
                : today,
            manualRateMaxAgeDays: days,
          }
        : {
            source: 'AUTOMATIC',
            manualSince: null,
            manualRateMaxAgeDays: days,
          };
    }, ctx);
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
    if (
      before.source !== after.source ||
      before.manualRateMaxAgeDays !== after.manualRateMaxAgeDays
    ) {
      // DX-380: con la otra fuente (DX-384: u otro plazo), sus abonos sin
      // tasa se intentan ya.
      await this.hooks.afterRatesChange();
    }
    return withBase(after);
  }
}
