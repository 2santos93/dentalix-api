import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GetDiscountPolicyUseCase } from '../../../discounts/application/use-cases/discount-policy.use-cases';
import {
  CURRENCY_DIGITS_CATALOG,
  type CurrencyDigitsCatalog,
} from '../../../../shared/money/currency-digits';
import { locationTimeZoneRequired } from '../../../../shared/locations/location-time-zone';
import { IDEMPOTENCY_KEY_INVALID_MESSAGE } from '../../../../shared/validation/idempotency-key';
import {
  PRICING_SOURCE,
  type PricingSource,
} from '../../domain/ports/pricing-source.port';
import {
  NO_REFERENCE_RATES,
  REFERENCE_RATE_SOURCE,
  type ReferenceRateSource,
} from '../../domain/ports/reference-rate-source.port';
import {
  PLAN_QUOTE_ZONES,
  type PlanQuoteZones,
} from '../../domain/ports/plan-quote-zones.port';
import {
  QUOTE_SETTINGS_REPOSITORY,
  type QuoteSettingsRepository,
} from '../../domain/ports/quote-settings-repository.port';
import {
  PLAN_REPRICING_REPOSITORY,
  type PlanRepricingRepository,
  type RepricingRecord,
  type RepricingSubject,
} from '../../domain/ports/plan-repricing-repository.port';
import { issueQuoteValidity } from '../../domain/quote-validity';
import type { TreatmentPlanWithItems } from '../../domain/entities/treatment-plan.entity';
import { TREATMENT_PLAN_CLOCK, type PlanClock } from '../plan-clock';
import { memoizedRates, resolveCurrentReference } from '../current-reference';
import {
  REPRICE_NOTHING_CODE,
  REPRICE_NOTHING_MESSAGE,
  REPRICE_STALE_CODE,
  REPRICE_STALE_MESSAGE,
  assertPlanRepriceable,
  computeRepricing,
  repricingCatalogItemIds,
  repricingConflict,
  type Repricing,
  type RepricingInput,
  type RepricingReference,
} from '../repricing';
import { freezeWithRate, withAgreementBase } from './reference-rate';
import type { DiscountActor } from './item-discount';

/** 400: `/reprice/apply` sin la cabecera Idempotency-Key. */
export const REPRICE_IDEMPOTENCY_KEY_REQUIRED_MESSAGE =
  'Falta la clave de idempotencia (cabecera Idempotency-Key): genera una y vuelve a intentarlo.';
/** 422: la misma Idempotency-Key con otra petición. */
export const REPRICE_IDEMPOTENCY_KEY_REUSED_CODE = 'IDEMPOTENCY_KEY_REUSED';
export const REPRICE_IDEMPOTENCY_KEY_REUSED_MESSAGE =
  'Esta clave de idempotencia ya se usó para otra actualización de precios (otro plan, otra vista previa u otros ítems). Vuelve a abrir la vista previa para generar una clave nueva.';
export const REPRICE_PLAN_NOT_FOUND_MESSAGE =
  'Plan de tratamiento no encontrado';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RepricingRequest {
  /** Ítems a recotizar; sin ellos, todos los propuestos. */
  itemIds?: string[];
}

export interface ApplyRepricingRequest extends RepricingRequest {
  /** La huella que devolvió la vista previa. */
  previewHash: string;
}

/** La recotización aplicada y si es la repetición de una ya aplicada. */
export interface AppliedRepricing {
  record: RepricingRecord;
  replayed: boolean;
}

/**
 * SHA-256 de lo que identifica una petición de aplicar: el plan, la huella de
 * la vista previa y los ítems pedidos (sin repetir, en orden). La misma clave
 * con otra huella es otra petición: 422.
 */
export function repricingRequestFingerprint(
  planId: string,
  request: ApplyRepricingRequest,
): string {
  const items = request.itemIds?.length
    ? [...new Set(request.itemIds.map((id) => id.toLowerCase()))].sort()
    : null;
  return createHash('sha256')
    .update(
      JSON.stringify([
        planId.toLowerCase(),
        request.previewHash.toLowerCase(),
        items,
      ]),
    )
    .digest('hex');
}

/**
 * Lo que la recotización necesita además del plan, leído ANTES de su
 * transacción (como el alta del ítem): el precio vigente de cada
 * procedimiento (la misma resolución que el alta, con la tasa de hoy pedida
 * una vez por moneda), la política de descuentos, los dígitos de la moneda y
 * la validez nueva (hoy en la sede del plan + días del ajuste).
 */
@Injectable()
export class RepricingContextReader {
  private readonly logger = new Logger(RepricingContextReader.name);

  constructor(
    @Inject(PRICING_SOURCE)
    private readonly pricing: PricingSource,
    private readonly discountPolicy: GetDiscountPolicyUseCase,
    @Inject(TREATMENT_PLAN_CLOCK)
    private readonly now: PlanClock,
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly currencyDigits: CurrencyDigitsCatalog,
    @Inject(QUOTE_SETTINGS_REPOSITORY)
    private readonly quoteSettings: QuoteSettingsRepository,
    @Inject(PLAN_QUOTE_ZONES)
    private readonly zones: PlanQuoteZones,
    @Optional()
    @Inject(REFERENCE_RATE_SOURCE)
    private readonly rates: ReferenceRateSource = NO_REFERENCE_RATES,
  ) {}

  async read(
    plan: TreatmentPlanWithItems,
    request: RepricingRequest,
    actor: DiscountActor,
  ): Promise<Omit<RepricingInput, 'plan' | 'itemIds'>> {
    const rates = memoizedRates(this.rates);
    const references = new Map<string, RepricingReference>();
    for (const catalogItemId of repricingCatalogItemIds(
      plan,
      request.itemIds,
    )) {
      references.set(
        catalogItemId,
        await this.referenceFor(rates, plan, catalogItemId, actor),
      );
    }
    const [policy, digits, settings, validity] = await Promise.all([
      this.discountPolicy.execute(),
      this.currencyDigits.table([plan.currency]),
      this.quoteSettings.get(),
      this.validityZone(plan),
    ]);
    const at = this.now();
    return {
      references,
      digits: digits.roundingDigits(plan.currency),
      policy,
      actor,
      at,
      validity: issueQuoteValidity(at, validity, settings.validityDays),
    };
  }

  private async referenceFor(
    rates: ReferenceRateSource,
    plan: TreatmentPlanWithItems,
    catalogItemId: string,
    actor: DiscountActor,
  ): Promise<RepricingReference> {
    const current = await resolveCurrentReference(
      this.pricing,
      rates,
      plan.patientId,
      catalogItemId,
      plan.currency,
    );
    if (!current || current.resolved.price === null) {
      return { kind: 'no-price' };
    }
    const { asked, priced } = current;
    if (asked?.lookup.kind === 'missing') {
      return { kind: 'no-rate', currency: asked.lookup.currency };
    }
    // DX-513-ter: la base de una lista de convenio, como en el alta.
    const reference = await withAgreementBase(
      rates,
      priced,
      plan.currency,
      freezeWithRate(priced, plan.currency, asked, actor.role),
      (message) => this.logger.warn(message),
    );
    return {
      kind: 'priced',
      resolved: current.resolved,
      catalogCurrency: current.catalogCurrency,
      pricingLocationId: current.context.locationId,
      reference,
    };
  }

  /**
   * D-13: la zona de la sede del plan (la de su presentación o, sin
   * presentar, la de escritura del request). Sin zona válida, 409
   * `LOCATION_TIMEZONE_REQUIRED` (nunca otra zona).
   */
  private async validityZone(plan: TreatmentPlanWithItems): Promise<string> {
    const presented = plan.presentedLocationId;
    const zoneOf = await this.zones.zonesFor(presented ? [presented] : []);
    const zone = zoneOf(presented);
    if (zone) return zone;
    if (presented) throw locationTimeZoneRequired(presented);
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'LOCATION_TIMEZONE_REQUIRED',
      message:
        'Configura una zona horaria válida para la sede y vuelve a intentarlo.',
    });
  }
}

async function loadSubject(
  repo: PlanRepricingRepository,
  patientId: string,
  planId: string,
): Promise<RepricingSubject> {
  const subject = await repo.load(patientId, planId);
  if (!subject) throw new NotFoundException(REPRICE_PLAN_NOT_FOUND_MESSAGE);
  return subject;
}

/**
 * `POST …/reprice/preview` (DX-379 porción B): cómo quedaría el plan con los
 * precios vigentes, sin escribir nada. Devuelve la huella que exige aplicar.
 */
@Injectable()
export class PreviewPlanRepricingUseCase {
  constructor(
    @Inject(PLAN_REPRICING_REPOSITORY)
    private readonly repo: PlanRepricingRepository,
    private readonly context: RepricingContextReader,
  ) {}

  async execute(
    patientId: string,
    planId: string,
    request: RepricingRequest,
    actor: DiscountActor,
  ): Promise<Repricing> {
    const { plan, facts } = await loadSubject(this.repo, patientId, planId);
    assertPlanRepriceable(plan, facts);
    const context = await this.context.read(plan, request, actor);
    return computeRepricing({ plan, itemIds: request.itemIds, ...context });
  }
}

/**
 * `POST …/reprice/apply` (DX-379 porción B): recalcula la recotización con el
 * plan bloqueado (la misma función que la vista previa) y la aplica solo si
 * su huella es la de la vista previa; si no, 409 y nada cambia. Reinicia la
 * validez del presupuesto. Idempotente por la cabecera Idempotency-Key
 * (obligatoria).
 */
@Injectable()
export class ApplyPlanRepricingUseCase {
  constructor(
    @Inject(PLAN_REPRICING_REPOSITORY)
    private readonly repo: PlanRepricingRepository,
    private readonly context: RepricingContextReader,
  ) {}

  async execute(
    patientId: string,
    planId: string,
    request: ApplyRepricingRequest,
    actor: DiscountActor,
    idempotencyKey: string | undefined,
  ): Promise<AppliedRepricing> {
    const key = idempotencyKey?.trim();
    if (!key) {
      throw new BadRequestException(REPRICE_IDEMPOTENCY_KEY_REQUIRED_MESSAGE);
    }
    if (!UUID_RE.test(key)) {
      throw new BadRequestException(IDEMPOTENCY_KEY_INVALID_MESSAGE);
    }
    const fingerprint = repricingRequestFingerprint(planId, request);
    // El precio vigente se lee antes de la transacción (solo lee, como el
    // alta); con el plan bloqueado se recalcula y se compara la huella.
    const { plan } = await loadSubject(this.repo, patientId, planId);
    const context = await this.context.read(plan, request, actor);
    const outcome = await this.repo.apply(
      patientId,
      planId,
      { key: key.toLowerCase(), fingerprint },
      actor.userId,
      ({ plan: locked, facts }) => {
        assertPlanRepriceable(locked, facts);
        const needed = repricingCatalogItemIds(locked, request.itemIds);
        if (needed.some((id) => !context.references.has(id))) {
          throw repricingConflict(REPRICE_STALE_CODE, REPRICE_STALE_MESSAGE);
        }
        const repricing = computeRepricing({
          plan: locked,
          itemIds: request.itemIds,
          ...context,
        });
        if (repricing.previewHash !== request.previewHash.toLowerCase()) {
          throw repricingConflict(REPRICE_STALE_CODE, REPRICE_STALE_MESSAGE);
        }
        if (repricing.lines.length === 0) {
          throw repricingConflict(
            REPRICE_NOTHING_CODE,
            REPRICE_NOTHING_MESSAGE,
          );
        }
        return repricing;
      },
    );
    switch (outcome.kind) {
      case 'key-reused':
        throw new UnprocessableEntityException({
          statusCode: 422,
          error: 'Unprocessable Entity',
          code: REPRICE_IDEMPOTENCY_KEY_REUSED_CODE,
          message: REPRICE_IDEMPOTENCY_KEY_REUSED_MESSAGE,
        });
      case 'replayed':
        return { record: outcome.record, replayed: true };
      case 'applied':
        return { record: outcome.record, replayed: false };
    }
  }
}
