import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { decimalPlaces } from '../../../../shared/validation/bounded-decimal';
import {
  civilDateIn,
  parseCivilDate,
  zonedStartOfDay,
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';
import type { ManualExchangeRate } from '../../domain/entities/manual-exchange-rate.entity';
import { ExchangeSourceChangeHooks } from '../exchange-source-change-hooks';
import {
  BASE_CURRENCY,
  MANUAL_RATE_BASE_CURRENCY_MESSAGE,
  MANUAL_RATE_CURRENCY_MESSAGE,
  MANUAL_RATE_DATE_MESSAGE,
  MANUAL_RATE_DUPLICATE_MESSAGE,
  MANUAL_RATE_EFFECTIVE_FROM_DAY_MESSAGE,
  MANUAL_RATE_EFFECTIVE_FROM_FUTURE_MESSAGE,
  MANUAL_RATE_EFFECTIVE_FROM_MESSAGE,
  MANUAL_RATE_FUTURE_DATE_MESSAGE,
  MANUAL_RATE_IN_USE_MESSAGE,
  MANUAL_RATE_NOT_FOUND_MESSAGE,
  MANUAL_RATE_MAX,
  MANUAL_RATE_MAX_DECIMALS,
  MANUAL_RATE_MESSAGE,
  MANUAL_RATE_NOT_A_MEMBER_MESSAGE,
  MANUAL_RATES_LIST_DEFAULT,
  MANUAL_RATES_LIST_MAX,
} from '../../domain/exchange-rate-source';
import {
  MANUAL_EXCHANGE_RATE_REPOSITORY,
  ManualExchangeRateAuthorError,
  ManualExchangeRateInUseError,
  ManualExchangeRateNotFoundError,
  ManualExchangeRateTakenError,
  type ManualExchangeRateRepository,
} from '../../domain/ports/manual-exchange-rate-repository.port';

export interface RegisterManualExchangeRateInput {
  date: string;
  currency: string;
  rate: number;
  /**
   * DX-586: desde qué instante del día rige (ISO 8601 con zona). Sin él:
   * ahora si `date` es hoy en la sede; el inicio de ese día si es anterior.
   */
  effectiveFrom?: string;
}

// Un instante sin `Z` ni desfase lo leería `new Date` en la zona del servidor.
const EXPLICIT_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** DX-586: el instante `effectiveFrom` del alta, o `null` si no vale. */
function parseEffectiveFrom(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!ISO_INSTANT.test(text) || !EXPLICIT_OFFSET.test(text)) return null;
  const instant = new Date(text);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

function isValidRate(rate: unknown): rate is number {
  return (
    typeof rate === 'number' &&
    Number.isFinite(rate) &&
    rate > 0 &&
    rate <= MANUAL_RATE_MAX &&
    decimalPlaces(rate) <= MANUAL_RATE_MAX_DECIMALS
  );
}

function badRequest(message: string, field: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message,
    field,
  });
}

/**
 * Reloj de la tasa de cambio (como `PRESCRIPTION_CLOCK`): decide qué día es
 * «hoy» al registrar una tasa y al pasar a MANUAL. Inyectable para los tests.
 */
export const EXCHANGE_RATE_CLOCK = Symbol('EXCHANGE_RATE_CLOCK');

/**
 * Registra la tasa de un día y una moneda de la clínica del contexto (solo
 * ADMIN, lo exige la ruta; lo audita `@Audit`). Una tasa ya registrada no se
 * sobrescribe (409): si ningún abono la usó, se corrige con
 * `CorrectManualExchangeRateUseCase` (DX-375). Se puede registrar con la
 * fuente AUTOMATIC (así la clínica deja la de hoy lista antes de cambiar a
 * MANUAL); solo se usa con MANUAL: para los días desde `manualSince` y, la
 * de un día anterior, como tasa de respaldo de los abonos de ese día que
 * siguen sin tasa (DX-402).
 */
@Injectable()
export class RegisterManualExchangeRateUseCase {
  constructor(
    @Inject(MANUAL_EXCHANGE_RATE_REPOSITORY)
    private readonly repo: ManualExchangeRateRepository,
    @Inject(EXCHANGE_RATE_CLOCK)
    private readonly now: () => Date,
    private readonly hooks: ExchangeSourceChangeHooks,
  ) {}

  async execute(
    input: RegisterManualExchangeRateInput,
    actorUserId: string,
  ): Promise<ManualExchangeRate> {
    const date =
      typeof input.date === 'string' ? parseCivilDate(input.date) : null;
    if (!date || date < PERIOD_DAY_MIN || date > PERIOD_DAY_MAX) {
      throw badRequest(MANUAL_RATE_DATE_MESSAGE, 'date');
    }
    if (!isValidRate(input.rate)) {
      throw badRequest(MANUAL_RATE_MESSAGE, 'rate');
    }
    const currency =
      typeof input.currency === 'string'
        ? input.currency.trim().toUpperCase()
        : '';
    if (currency === BASE_CURRENCY) {
      throw badRequest(MANUAL_RATE_BASE_CURRENCY_MESSAGE, 'currency');
    }
    if (
      !/^[A-Z]{3}$/.test(currency) ||
      !(await this.repo.isKnownCurrency(currency))
    ) {
      throw badRequest(MANUAL_RATE_CURRENCY_MESSAGE, 'currency');
    }
    // «Hoy» en la zona de la sede de referencia: un día que aún no ha llegado
    // allí no tiene tasa que registrar.
    const now = this.now();
    const timeZone = await this.repo.referenceTimeZone();
    const today = civilDateIn(now, timeZone);
    if (date > today) {
      throw badRequest(MANUAL_RATE_FUTURE_DATE_MESSAGE, 'date');
    }
    const effectiveFrom = await this.effectiveFrom(
      input,
      { date, currency },
      today,
      now,
      timeZone,
    );
    let saved: ManualExchangeRate;
    try {
      saved = await this.repo.create({
        date,
        currency,
        rate: input.rate,
        effectiveFrom,
        createdById: actorUserId,
      });
    } catch (error) {
      if (error instanceof ManualExchangeRateTakenError) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'MANUAL_EXCHANGE_RATE_TAKEN',
          message: MANUAL_RATE_DUPLICATE_MESSAGE,
        });
      }
      if (error instanceof ManualExchangeRateAuthorError) {
        throw new ForbiddenException(MANUAL_RATE_NOT_A_MEMBER_MESSAGE);
      }
      throw error;
    }
    // DX-380: los abonos sin tasa de la clínica la toman en el barrido
    // siguiente, sin esperar a su reintento escalonado.
    await this.hooks.afterRatesChange();
    return saved;
  }

  /**
   * DX-586: desde cuándo rige la tasa. La pedida tiene que ser un instante
   * con zona, no futuro y del mismo día civil `date` en la sede de
   * referencia. Sin ella: ahora si es hoy y ya hay otra de esa moneda hoy (la
   * nueva rige desde ya); si es la primera del día de esa moneda (o un día
   * anterior), desde el inicio del día: así una clínica que registra una
   * tasa al día sigue cubriendo el día entero, como antes de DX-586.
   */
  private async effectiveFrom(
    input: RegisterManualExchangeRateInput,
    rate: { date: string; currency: string },
    today: string,
    now: Date,
    timeZone: string,
  ): Promise<Date> {
    const { date } = rate;
    if (input.effectiveFrom === undefined || input.effectiveFrom === null) {
      if (date !== today) return zonedStartOfDay(date, timeZone);
      const sameDay = await this.repo.listDay(date);
      return sameDay.some((r) => r.currency === rate.currency)
        ? now
        : zonedStartOfDay(date, timeZone);
    }
    const instant = parseEffectiveFrom(input.effectiveFrom);
    if (!instant) {
      throw badRequest(MANUAL_RATE_EFFECTIVE_FROM_MESSAGE, 'effectiveFrom');
    }
    if (instant.getTime() > now.getTime()) {
      throw badRequest(
        MANUAL_RATE_EFFECTIVE_FROM_FUTURE_MESSAGE,
        'effectiveFrom',
      );
    }
    if (civilDateIn(instant, timeZone) !== date) {
      throw badRequest(MANUAL_RATE_EFFECTIVE_FROM_DAY_MESSAGE, 'effectiveFrom');
    }
    return instant;
  }
}

@Injectable()
export class ListManualExchangeRatesUseCase {
  constructor(
    @Inject(MANUAL_EXCHANGE_RATE_REPOSITORY)
    private readonly repo: ManualExchangeRateRepository,
  ) {}

  /** Las últimas tasas de la clínica: día más reciente primero. */
  execute(input: { limit?: number }): Promise<ManualExchangeRate[]> {
    const limit = Math.min(
      Math.max(1, Math.trunc(input.limit ?? MANUAL_RATES_LIST_DEFAULT)),
      MANUAL_RATES_LIST_MAX,
    );
    return this.repo.listRecent(limit);
  }
}

/**
 * DX-375: corrige la tasa de una tasa manual de la clínica del contexto (solo
 * ADMIN, lo exige la ruta; lo audita `@Audit`), solo si ningún abono la congeló
 * todavía: una tasa usada responde 409 `MANUAL_EXCHANGE_RATE_IN_USE` (el
 * trigger `manual_exchange_rates_in_use_guard` lo garantiza también en la BD).
 * El día y la moneda no cambian.
 */
@Injectable()
export class CorrectManualExchangeRateUseCase {
  constructor(
    @Inject(MANUAL_EXCHANGE_RATE_REPOSITORY)
    private readonly repo: ManualExchangeRateRepository,
    private readonly hooks: ExchangeSourceChangeHooks,
  ) {}

  async execute(
    id: string,
    input: { rate: number },
  ): Promise<ManualExchangeRate> {
    if (!isValidRate(input.rate)) {
      throw badRequest(MANUAL_RATE_MESSAGE, 'rate');
    }
    let saved: ManualExchangeRate;
    try {
      saved = await this.repo.correct(id, input.rate);
    } catch (error) {
      if (error instanceof ManualExchangeRateNotFoundError) {
        throw new NotFoundException(MANUAL_RATE_NOT_FOUND_MESSAGE);
      }
      if (error instanceof ManualExchangeRateInUseError) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'MANUAL_EXCHANGE_RATE_IN_USE',
          message: MANUAL_RATE_IN_USE_MESSAGE,
        });
      }
      throw error;
    }
    // DX-380: como al registrarla, los abonos sin tasa la intentan ya.
    await this.hooks.afterRatesChange();
    return saved;
  }
}
