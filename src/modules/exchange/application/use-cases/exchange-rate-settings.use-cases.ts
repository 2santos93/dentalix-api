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
import {
  applyClinicCurrenciesPatch,
  hasClinicCurrenciesPatch,
  patchCurrencyCodes,
  type ClinicCurrencies,
  type ClinicCurrenciesPatch,
} from '../../domain/clinic-currencies';
import {
  CLINIC_CURRENCIES_REPOSITORY,
  type ClinicCurrenciesRepository,
} from '../../domain/ports/clinic-currencies-repository.port';

export const EXCHANGE_SETTINGS_EMPTY_MESSAGE =
  'Indica qué quieres cambiar: la fuente de la tasa, el plazo de la última tasa registrada o las monedas de la clínica.';

export interface ExchangeRateSettings
  extends ClinicExchangeSettings, ClinicCurrencies {
  /** Moneda base de todas las tasas (unidades de cada moneda por 1 de ella). */
  baseCurrency: string;
}

const withBase = (
  settings: ClinicExchangeSettings,
  currencies: ClinicCurrencies,
): ExchangeRateSettings => ({
  source: settings.source,
  manualSince: settings.manualSince,
  manualRateMaxAgeDays: settings.manualRateMaxAgeDays,
  baseCurrency: BASE_CURRENCY,
  // DX-584: monedas de la clínica y tasa en el menú.
  acceptedCurrencies: currencies.acceptedCurrencies,
  rateReferenceCurrency: currencies.rateReferenceCurrency,
  showRateInHeader: currencies.showRateInHeader,
});

@Injectable()
export class GetExchangeRateSettingsUseCase {
  constructor(
    @Inject(CLINIC_EXCHANGE_SETTINGS_REPOSITORY)
    private readonly settings: ClinicExchangeSettingsRepository,
    @Inject(CLINIC_CURRENCIES_REPOSITORY)
    private readonly currencies: ClinicCurrenciesRepository,
  ) {}

  async execute(): Promise<ExchangeRateSettings> {
    const [settings, currencies] = await Promise.all([
      this.settings.get(),
      this.currencies.get(),
    ]);
    return withBase(settings, currencies);
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
 * DX-585: BCV (VES y EUR de la tasa oficial del BCV, el resto automático) se
 * guarda como AUTOMATIC: `manualSince` null, mismos hooks de congelación y de
 * abonos sin tasa y el mismo evento de auditoría (EXCHANGE_RATE_SOURCE con el
 * antes y el después). Las tasas manuales registradas se conservan, pero con
 * BCV no se usan.
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
 *
 * DX-584: también las monedas de la clínica (`acceptedCurrencies`,
 * `rateReferenceCurrency`, `showRateInHeader`), cada una opcional. Se valida
 * el RESULTADO con la fila bloqueada (catálogo, sin repetidas, 0..8 y la
 * referencia entre las aceptadas o la de alguna sede) ANTES de tocar la
 * fuente o el plazo: un 400 no deja nada a medias. Evento CLINIC_SETTINGS
 * CLINIC_CURRENCIES con el antes y el después, en la transacción del cambio.
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
    @Inject(CLINIC_CURRENCIES_REPOSITORY)
    private readonly currencies: ClinicCurrenciesRepository,
  ) {}

  async execute(
    input: {
      source?: ExchangeRateSource;
      manualRateMaxAgeDays?: number;
    } & ClinicCurrenciesPatch,
    ctx: AuditRequestContext,
  ): Promise<ExchangeRateSettings> {
    const { source, manualRateMaxAgeDays: maxAge } = input;
    const currenciesPatch: ClinicCurrenciesPatch = {
      acceptedCurrencies: input.acceptedCurrencies,
      rateReferenceCurrency: input.rateReferenceCurrency,
      showRateInHeader: input.showRateInHeader,
    };
    const withCurrencies = hasClinicCurrenciesPatch(currenciesPatch);
    if (source === undefined && maxAge === undefined && !withCurrencies) {
      throw new BadRequestException(EXCHANGE_SETTINGS_EMPTY_MESSAGE);
    }
    if (source !== undefined && !EXCHANGE_RATE_SOURCES.includes(source)) {
      throw new BadRequestException(EXCHANGE_RATE_SOURCE_MESSAGE);
    }
    if (maxAge !== undefined && !isValidManualRateMaxAge(maxAge)) {
      throw new BadRequestException(MANUAL_RATE_MAX_AGE_MESSAGE);
    }
    // DX-584: las monedas primero (pueden dar 400 sin haber tocado nada).
    const currencies = withCurrencies
      ? (await this.updateCurrencies(currenciesPatch, ctx)).after
      : await this.currencies.get();
    if (source === undefined && maxAge === undefined) {
      return withBase(await this.settings.get(), currencies);
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
            // DX-585: BCV se comporta como AUTOMATIC: sin `manualSince`.
            source,
            manualSince: null,
            manualRateMaxAgeDays: days,
          };
    }, ctx);
    // DX-384: el evento del plazo (EXCHANGE_RATE_MAX_AGE, con el id de la
    // clínica) lo escribe el repositorio en la transacción del cambio; este,
    // el de la fuente (DX-374, `resourceId` null), sigue yendo fuera para no
    // tocar su contrato ni su orden con los hooks de congelación. Un PUT con
    // los dos campos deja los dos eventos.
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
    return withBase(after, currencies);
  }

  private async updateCurrencies(
    patch: ClinicCurrenciesPatch,
    ctx: AuditRequestContext,
  ): Promise<{ before: ClinicCurrencies; after: ClinicCurrencies }> {
    const [known, locationCurrencies] = await Promise.all([
      this.currencies.knownCurrencies(patchCurrencyCodes(patch)),
      this.currencies.locationCurrencies(),
    ]);
    return this.currencies.set((before) => {
      const result = applyClinicCurrenciesPatch(before, patch, {
        isKnown: (code) => known.has(code),
        locationCurrencies,
      });
      if (!result.ok) throw new BadRequestException(result.message);
      return result.value;
    }, ctx);
  }
}
