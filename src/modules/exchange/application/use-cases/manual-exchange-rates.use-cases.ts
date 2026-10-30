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
    const today = civilDateIn(this.now(), await this.repo.referenceTimeZone());
    if (date > today) {
      throw badRequest(MANUAL_RATE_FUTURE_DATE_MESSAGE, 'date');
    }
    let saved: ManualExchangeRate;
    try {
      saved = await this.repo.create({
        date,
        currency,
        rate: input.rate,
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
