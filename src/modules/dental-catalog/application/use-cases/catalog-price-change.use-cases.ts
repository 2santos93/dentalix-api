import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CatalogKind, Prisma } from '@prisma/client';
import { IDEMPOTENCY_KEY_INVALID_MESSAGE } from '../../../../shared/validation/idempotency-key';
import {
  CATALOG_CURRENCY_READER,
  type CatalogCurrencyReader,
} from '../../domain/ports/catalog-currency-reader.port';
import {
  CATALOG_PRICE_CHANGE_REPOSITORY,
  type AppliedPriceBatch,
  type ApplyPriceChangeOutcome,
  type CatalogPriceChangeRepository,
  type CatalogPriceHistoryEntry,
} from '../../domain/ports/catalog-price-change-repository.port';
import {
  PRICE_CHANGE_MAX_ITEMS,
  PRICE_CHANGE_ROUNDING_UNITS,
  canonicalCriteria,
  planPriceChange,
  priceChangeRequestFingerprint,
  type PriceChangeCriteria,
  type PriceChangeMode,
  type PriceChangePlan,
  type PriceChangeRoundingUnit,
} from '../../domain/price-change';

/** Lo que llega del cliente (números ya validados por el DTO). */
export interface PriceChangeRequest {
  category?: string | null;
  kind?: CatalogKind | null;
  activeOnly?: boolean;
  priceBelow?: number | null;
  mode: PriceChangeMode;
  value: number;
  roundTo?: number | null;
  minIncrement?: number | null;
}

export interface ApplyPriceChangeRequest extends PriceChangeRequest {
  previewHash: string;
}

export interface AppliedPriceChange {
  batch: AppliedPriceBatch;
  replayed: boolean;
}

export const PRICE_CHANGE_PERCENT_MIN = -100;
export const PRICE_CHANGE_PERCENT_MAX = 1000;
export const PRICE_CHANGE_HISTORY_LIMIT = 200;

export const PRICE_CHANGE_VALUE_ZERO_MESSAGE =
  'El cambio no puede ser 0: indica un porcentaje o un importe distinto de cero.';
export const PRICE_CHANGE_PERCENT_RANGE_MESSAGE = `El porcentaje debe estar entre ${PRICE_CHANGE_PERCENT_MIN} y ${PRICE_CHANGE_PERCENT_MAX}.`;
export const PRICE_CHANGE_MIN_INCREMENT_MESSAGE =
  'El incremento mínimo solo se aplica a una subida de precios.';
export const PRICE_CHANGE_ROUNDING_MESSAGE =
  'El redondeo debe ser a 1, 10, 100 o 1.000 unidades (o sin redondeo).';
export const PRICE_CHANGE_IDEMPOTENCY_KEY_REQUIRED_MESSAGE =
  'Falta la clave de idempotencia (cabecera Idempotency-Key): genera una y vuelve a intentarlo.';
export const PRICE_CHANGE_IDEMPOTENCY_KEY_REUSED_CODE =
  'IDEMPOTENCY_KEY_REUSED';
export const PRICE_CHANGE_IDEMPOTENCY_KEY_REUSED_MESSAGE =
  'Esta clave de idempotencia ya se usó para otra actualización de precios del catálogo. Vuelve a abrir la vista previa para generar una clave nueva.';
export const PRICE_CHANGE_STALE_CODE = 'PRICE_CHANGE_PREVIEW_STALE';
export const PRICE_CHANGE_STALE_MESSAGE =
  'Los precios del catálogo cambiaron desde la vista previa: revísala de nuevo antes de aplicar.';
export const PRICE_CHANGE_NOTHING_CODE = 'PRICE_CHANGE_NOTHING_TO_APPLY';
export const PRICE_CHANGE_NOTHING_MESSAGE =
  'Con estos criterios ningún precio cambia: no hay nada que aplicar.';
export const PRICE_CHANGE_TOO_LARGE_CODE = 'PRICE_CHANGE_TOO_LARGE';
export const priceChangeTooLargeMessage = (count: number) =>
  `El lote cambiaría ${count} precios y el máximo por lote es ${PRICE_CHANGE_MAX_ITEMS}: filtra por categoría o tipo y aplícalo en varias veces.`;
export const CATALOG_ITEM_NOT_FOUND_MESSAGE =
  'Prestación no encontrada en el catálogo de esta clínica.';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decimalOrNull(
  value: number | null | undefined,
): Prisma.Decimal | null {
  return value === null || value === undefined
    ? null
    : new Prisma.Decimal(String(value));
}

/**
 * Los criterios del dominio a partir de la petición, con las reglas que
 * cruzan campos (el DTO valida cada uno por separado).
 */
export function toPriceChangeCriteria(
  request: PriceChangeRequest,
): PriceChangeCriteria {
  const value = new Prisma.Decimal(String(request.value));
  if (value.isZero()) {
    throw new BadRequestException(PRICE_CHANGE_VALUE_ZERO_MESSAGE);
  }
  if (
    request.mode === 'PERCENT' &&
    (value.lessThan(PRICE_CHANGE_PERCENT_MIN) ||
      value.greaterThan(PRICE_CHANGE_PERCENT_MAX))
  ) {
    throw new BadRequestException(PRICE_CHANGE_PERCENT_RANGE_MESSAGE);
  }
  const roundTo = request.roundTo ?? null;
  if (
    roundTo !== null &&
    !(PRICE_CHANGE_ROUNDING_UNITS as readonly number[]).includes(roundTo)
  ) {
    throw new BadRequestException(PRICE_CHANGE_ROUNDING_MESSAGE);
  }
  const minIncrement = decimalOrNull(request.minIncrement);
  if (minIncrement !== null && value.lessThan(0)) {
    throw new BadRequestException(PRICE_CHANGE_MIN_INCREMENT_MESSAGE);
  }
  return {
    filters: {
      category: request.category?.trim() || null,
      kind: request.kind ?? null,
      activeOnly: request.activeOnly === true,
      priceBelow: decimalOrNull(request.priceBelow),
    },
    mode: request.mode,
    value,
    roundTo: roundTo as PriceChangeRoundingUnit | null,
    minIncrement:
      minIncrement !== null && minIncrement.greaterThan(0)
        ? minIncrement
        : null,
  };
}

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

function assertBatchSize(plan: PriceChangePlan): void {
  if (plan.lines.length > PRICE_CHANGE_MAX_ITEMS) {
    throw new UnprocessableEntityException({
      statusCode: 422,
      error: 'Unprocessable Entity',
      code: PRICE_CHANGE_TOO_LARGE_CODE,
      message: priceChangeTooLargeMessage(plan.lines.length),
    });
  }
}

/**
 * `POST /catalog/price-changes/preview` (DX-205): qué precios cambiarían y
 * cómo, sin escribir nada. Devuelve la huella que exige `/apply`.
 */
@Injectable()
export class PreviewCatalogPriceChangeUseCase {
  constructor(
    @Inject(CATALOG_PRICE_CHANGE_REPOSITORY)
    private readonly repo: CatalogPriceChangeRepository,
    @Inject(CATALOG_CURRENCY_READER)
    private readonly currency: CatalogCurrencyReader,
  ) {}

  async execute(request: PriceChangeRequest): Promise<PriceChangePlan> {
    const criteria = toPriceChangeCriteria(request);
    const [items, currency] = await Promise.all([
      this.repo.candidates(),
      this.currency.current(),
    ]);
    const plan = planPriceChange(items, criteria, currency);
    assertBatchSize(plan);
    return plan;
  }
}

/**
 * `POST /catalog/price-changes/apply` (DX-205): recalcula el lote con el
 * catálogo bloqueado (la MISMA función que la vista previa) y lo aplica solo
 * si su huella es la de la vista previa; si no, 409 y nada cambia. Atómico e
 * idempotente por la cabecera Idempotency-Key (obligatoria).
 */
@Injectable()
export class ApplyCatalogPriceChangeUseCase {
  constructor(
    @Inject(CATALOG_PRICE_CHANGE_REPOSITORY)
    private readonly repo: CatalogPriceChangeRepository,
    @Inject(CATALOG_CURRENCY_READER)
    private readonly currency: CatalogCurrencyReader,
  ) {}

  async execute(
    request: ApplyPriceChangeRequest,
    actorUserId: string,
    idempotencyKey: string | undefined,
  ): Promise<AppliedPriceChange> {
    const key = idempotencyKey?.trim();
    if (!key) {
      throw new BadRequestException(
        PRICE_CHANGE_IDEMPOTENCY_KEY_REQUIRED_MESSAGE,
      );
    }
    if (!UUID_RE.test(key)) {
      throw new BadRequestException(IDEMPOTENCY_KEY_INVALID_MESSAGE);
    }
    const criteria = toPriceChangeCriteria(request);
    const previewHash = request.previewHash.toLowerCase();
    const idempotency = {
      key: key.toLowerCase(),
      fingerprint: priceChangeRequestFingerprint(criteria, previewHash),
    };
    // Una repetición devuelve lo aplicado aunque el catálogo haya cambiado
    // después (sin recalcular nada).
    const replay = await this.repo.findApplied(idempotency);
    if (replay) return settled(replay);

    const currency = await this.currency.current();
    const outcome = await this.repo.apply(
      idempotency,
      actorUserId,
      canonicalCriteria(criteria),
      (items) => {
        const plan = planPriceChange(items, criteria, currency);
        if (plan.previewHash !== previewHash) {
          throw conflict(PRICE_CHANGE_STALE_CODE, PRICE_CHANGE_STALE_MESSAGE);
        }
        if (plan.lines.length === 0) {
          throw conflict(
            PRICE_CHANGE_NOTHING_CODE,
            PRICE_CHANGE_NOTHING_MESSAGE,
          );
        }
        assertBatchSize(plan);
        return plan;
      },
    );
    return settled(outcome);
  }
}

function settled(outcome: ApplyPriceChangeOutcome): AppliedPriceChange {
  switch (outcome.kind) {
    case 'key-reused':
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        code: PRICE_CHANGE_IDEMPOTENCY_KEY_REUSED_CODE,
        message: PRICE_CHANGE_IDEMPOTENCY_KEY_REUSED_MESSAGE,
      });
    case 'replayed':
      return { batch: outcome.batch, replayed: true };
    case 'applied':
      return { batch: outcome.batch, replayed: false };
  }
}

/** `GET /catalog/items/:id/price-history` (DX-205). 404 si no es de la clínica. */
@Injectable()
export class GetCatalogPriceHistoryUseCase {
  constructor(
    @Inject(CATALOG_PRICE_CHANGE_REPOSITORY)
    private readonly repo: CatalogPriceChangeRepository,
  ) {}

  async execute(catalogItemId: string): Promise<CatalogPriceHistoryEntry[]> {
    const entries = await this.repo.history(
      catalogItemId,
      PRICE_CHANGE_HISTORY_LIMIT,
    );
    if (entries === null) {
      throw new NotFoundException(CATALOG_ITEM_NOT_FOUND_MESSAGE);
    }
    return entries;
  }
}
