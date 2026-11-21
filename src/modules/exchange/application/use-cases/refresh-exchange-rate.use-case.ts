import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { ExchangeRateSource } from '../../domain/exchange-rate-source';
import {
  ExchangeRateBudgetExceededError,
  ExchangeRateUnavailableError,
} from '../../domain/ports/exchange-rate-provider.port';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { civilDateIn } from '../../../../shared/time/civil-day';
import {
  CLINIC_EXCHANGE_SETTINGS_REPOSITORY,
  type ClinicExchangeSettingsRepository,
} from '../../domain/ports/clinic-exchange-settings-repository.port';
import {
  CLINIC_CURRENCIES_REPOSITORY,
  type ClinicCurrenciesRepository,
} from '../../domain/ports/clinic-currencies-repository.port';
import {
  EXCHANGE_REFRESH_COOLDOWN,
  EXCHANGE_REFRESH_COOLDOWN_SECONDS,
  type ExchangeRefreshCooldown,
} from '../../domain/ports/exchange-refresh-cooldown.port';
import { ExchangeSourceChangeHooks } from '../exchange-source-change-hooks';
import {
  GetExchangeHeaderUseCase,
  type ExchangeHeader,
} from './get-exchange-header.use-case';
import { GetRatesForDateUseCase } from './get-rates-for-date.use-case';
import { EXCHANGE_RATE_CLOCK } from './manual-exchange-rates.use-cases';
import {
  BcvRateRejectedError,
  RefreshBcvRateUseCase,
} from './refresh-bcv-rate.use-case';

export const EXCHANGE_REFRESH_MANUAL_MESSAGE =
  'Con tasa manual, registra la nueva tasa en Ajustes.';
export const EXCHANGE_REFRESH_BCV_REJECTED_MESSAGE =
  'La tasa del BCV que se leyó no pasó la revisión y no se guardó. Se volverá a consultar sola.';
export const EXCHANGE_REFRESH_BCV_UNAVAILABLE_MESSAGE =
  'No pudimos consultar el BCV ni su respaldo. Se sigue usando la última tasa guardada.';
export const EXCHANGE_REFRESH_UNAVAILABLE_MESSAGE =
  'No pudimos consultar la tasa de hoy. Se sigue usando la última tasa guardada.';
export const EXCHANGE_REFRESH_BUDGET_MESSAGE =
  'La clínica consultó demasiadas tasas sin guardar. Se sigue usando la última tasa guardada.';

/** DX-586: qué pasó al consultar la fuente. */
export interface ExchangeRefreshOutcome {
  /** La tasa se consultó y quedó guardada. */
  ok: boolean;
  /** Sin `ok`: EXCHANGE_RATE_UNAVAILABLE, _BUDGET_EXCEEDED o _BCV_REJECTED. */
  code: string | null;
  /** Sin `ok`: el mensaje en español para la persona. */
  message: string | null;
}

/** El cuerpo de GET /exchange/header más el resultado de la consulta. */
export type ExchangeRefreshResult = ExchangeHeader & {
  refresh: ExchangeRefreshOutcome;
};

function failed(code: string, message: string): ExchangeRefreshOutcome {
  return { ok: false, code, message };
}

/** «Vuelve a intentarlo en N min» (redondeando hacia arriba). */
export function refreshTooSoonMessage(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Vuelve a intentarlo en ${minutes} min.`;
}

/**
 * DX-586: 429 propio de «Actualizar tasa» (una vez cada 5 min por clínica).
 * El controlador pone `Retry-After` con `retryAfterSeconds`.
 */
export class ExchangeRefreshTooSoonError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('exchange refresh too soon');
    this.name = 'ExchangeRefreshTooSoonError';
  }

  response() {
    return {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      code: 'EXCHANGE_RATE_REFRESH_TOO_SOON',
      message: refreshTooSoonMessage(this.retryAfterSeconds),
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
}

/**
 * DX-586: «Actualizar tasa» del indicador del menú. Con la fuente de la
 * clínica:
 * - BCV: vuelve a consultar el BCV ya (página oficial → respaldo), como el
 *   trabajo programado, con su cordura y su arranque en frío;
 * - AUTOMATIC: vuelve a pedir al proveedor las tasas de hoy en la sede,
 *   aunque estén en caché (gasta del presupuesto de la clínica, SEC-054);
 * - MANUAL: 409, no hay nada que consultar (se registra en Ajustes).
 * Una vez cada 5 min por clínica (429 con lo que falta); el turno se toma
 * antes de consultar, así que una consulta que falla también lo gasta (no se
 * insiste contra un proveedor caído). Si la consulta sale bien, adelanta los
 * reintentos de los abonos sin tasa (DX-380) y deja el evento CLINIC_SETTINGS
 * `EXCHANGE_RATE_REFRESH`. Devuelve siempre el indicador recalculado (el
 * cuerpo de GET /exchange/header) con `refresh`: si la fuente no dio la tasa,
 * `ok: false` con su código y su mensaje, nunca un 5xx (como el indicador).
 */
@Injectable()
export class RefreshExchangeRateUseCase {
  constructor(
    @Inject(CLINIC_EXCHANGE_SETTINGS_REPOSITORY)
    private readonly settings: ClinicExchangeSettingsRepository,
    @Inject(CLINIC_CURRENCIES_REPOSITORY)
    private readonly currencies: ClinicCurrenciesRepository,
    @Inject(EXCHANGE_REFRESH_COOLDOWN)
    private readonly cooldown: ExchangeRefreshCooldown,
    private readonly refreshBcv: RefreshBcvRateUseCase,
    private readonly rates: GetRatesForDateUseCase,
    private readonly header: GetExchangeHeaderUseCase,
    private readonly hooks: ExchangeSourceChangeHooks,
    private readonly audit: RecordAuditEventUseCase,
    @Inject(EXCHANGE_RATE_CLOCK)
    private readonly now: () => Date,
  ) {}

  async execute(ctx: AuditRequestContext): Promise<ExchangeRefreshResult> {
    const { source } = await this.settings.get();
    if (source === 'MANUAL') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'EXCHANGE_RATE_REFRESH_MANUAL',
        message: EXCHANGE_REFRESH_MANUAL_MESSAGE,
      });
    }
    const claim = await this.cooldown.claim(EXCHANGE_REFRESH_COOLDOWN_SECONDS);
    if (!claim.ok)
      throw new ExchangeRefreshTooSoonError(claim.retryAfterSeconds);

    const failure = await this.consult(source);
    if (failure) {
      // El turno queda gastado (no se insiste contra una fuente caída) y la
      // respuesta es el indicador de siempre con lo que pasó: como GET
      // /exchange/header, nunca un 5xx por la fuente de la tasa.
      return { ...(await this.header.execute()), refresh: failure };
    }

    await this.hooks.afterRatesChange();
    await this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'UPDATE',
      resourceType: 'CLINIC_SETTINGS',
      resourceId: ctx.tenantId,
      patient: null,
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: 'EXCHANGE_RATE_REFRESH' },
    });
    return {
      ...(await this.header.execute()),
      refresh: { ok: true, code: null, message: null },
    };
  }

  /**
   * Consulta la fuente; `null` si la tasa quedó guardada, o qué falló (la
   * fuente no la dio, el presupuesto del proveedor, la cordura del BCV o un
   * día fuera de la ventana del proveedor). Cualquier otro fallo se propaga.
   */
  private async consult(
    source: ExchangeRateSource,
  ): Promise<ExchangeRefreshOutcome | null> {
    try {
      if (source === 'BCV') await this.refreshBcv.execute();
      else await this.rates.refreshProviderRates(await this.today());
      return null;
    } catch (error) {
      if (error instanceof BcvRateRejectedError) {
        return failed(
          'EXCHANGE_RATE_BCV_REJECTED',
          EXCHANGE_REFRESH_BCV_REJECTED_MESSAGE,
        );
      }
      if (error instanceof ExchangeRateBudgetExceededError) {
        return failed(
          'EXCHANGE_RATE_BUDGET_EXCEEDED',
          EXCHANGE_REFRESH_BUDGET_MESSAGE,
        );
      }
      if (error instanceof ExchangeRateUnavailableError) {
        return failed(
          'EXCHANGE_RATE_UNAVAILABLE',
          source === 'BCV'
            ? EXCHANGE_REFRESH_BCV_UNAVAILABLE_MESSAGE
            : EXCHANGE_REFRESH_UNAVAILABLE_MESSAGE,
        );
      }
      if (error instanceof BadRequestException) {
        return failed(
          'EXCHANGE_RATE_UNAVAILABLE',
          EXCHANGE_REFRESH_UNAVAILABLE_MESSAGE,
        );
      }
      throw error;
    }
  }
  /** Hoy en la sede del menú (la activa o la principal). */
  private async today(): Promise<string> {
    const location = await this.currencies.headerLocation();
    const timeZone =
      location?.timeZone ?? (await this.settings.principalTimeZone());
    return civilDateIn(this.now(), timeZone);
  }
}
