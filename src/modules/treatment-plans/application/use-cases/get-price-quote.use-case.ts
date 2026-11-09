import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { PriceSource } from '@prisma/client';
import {
  PRICING_SOURCE,
  type PricingSource,
} from '../../domain/ports/pricing-source.port';
import { resolveCurrentReference } from '../current-reference';
import {
  PATIENT_AGREEMENT_REPOSITORY,
  type PatientAgreementRepository,
} from '../../../patient-agreements/domain/ports/patient-agreement-repository.port';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patient-coverages/domain/coverage-rules';
import {
  freezeReference,
  type FrozenReferenceRate,
} from '../../../discounts/domain/reference-in-plan';
import {
  NO_REFERENCE_RATES,
  REFERENCE_RATE_SOURCE,
  type ReferenceRateSource,
} from '../../domain/ports/reference-rate-source.port';

export const PRICE_QUOTE_CATALOG_ITEM_NOT_FOUND_MESSAGE =
  'Procedimiento no encontrado.';

/** Precio que tendría el ítem si se añadiera ahora (DX-105 §4.2). */
export interface PriceQuote {
  basePrice: number | null;
  /** DX-502: moneda de `basePrice` (la del catálogo); null si no se sabe. */
  catalogCurrency: string | null;
  price: number | null;
  source: PriceSource;
  agreementId: string | null;
  agreementName: string | null;
  allowDiscount: boolean;
  currency: string;
  /**
   * DX-513-bis: moneda de `price` (la del plan para las listas, la del
   * catálogo para el resto); null si no se sabe o no hay precio.
   */
  referenceCurrency: string | null;
  /**
   * DX-513-bis: `price` en la moneda del plan (convertido con la tasa de hoy
   * si está en otra moneda): el precio que se propone y la referencia del
   * descuento. Null sin precio o sin tasa (`rateMissing`).
   */
  referencePriceInPlan: number | null;
  /** DX-513-bis: la tasa con que se convirtió; null si no hizo falta. */
  rate: FrozenReferenceRate | null;
  /**
   * DX-513-bis: hacía falta una tasa y no hay: el alta respondería 422
   * `DISCOUNT_REFERENCE_RATE_MISSING`.
   */
  rateMissing: boolean;
  /** DX-513-bis: la moneda sin tasa (con `rateMissing`); null si no falta. */
  missingRateCurrency: string | null;
}

/**
 * `GET /patients/:patientId/price-quote`: la misma resolución que el alta del
 * ítem (§3), con la sede del request, sin escribir nada. La web precarga con
 * ella el precio y su origen; el alta vuelve a resolver en el servidor.
 */
@Injectable()
export class GetPriceQuoteUseCase {
  constructor(
    @Inject(PRICING_SOURCE)
    private readonly pricing: PricingSource,
    @Inject(PATIENT_AGREEMENT_REPOSITORY)
    private readonly patients: Pick<
      PatientAgreementRepository,
      'patientExists'
    >,
    // DX-513-bis: sin fuente (specs que no la necesitan), «sin tasa».
    @Optional()
    @Inject(REFERENCE_RATE_SOURCE)
    private readonly rates: ReferenceRateSource = NO_REFERENCE_RATES,
  ) {}

  async execute(
    patientId: string,
    catalogItemId: string,
    currency: string,
  ): Promise<PriceQuote> {
    if (!(await this.patients.patientExists(patientId))) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    // DX-379 (D.1): la misma resolución que el alta y la recotización: la
    // misma foto que tomaría el alta (DX-513-bis §5.3), sin escribir nada.
    // Sin tasa no lanza, lo dice (`rateMissing`).
    const current = await resolveCurrentReference(
      this.pricing,
      this.rates,
      patientId,
      catalogItemId,
      currency,
    );
    if (!current) {
      throw new NotFoundException(PRICE_QUOTE_CATALOG_ITEM_NOT_FOUND_MESSAGE);
    }
    const { resolved, priced, asked } = current;
    if (asked?.lookup.kind === 'missing') {
      return {
        ...resolved,
        currency,
        referenceCurrency: asked.currency,
        referencePriceInPlan: null,
        rate: null,
        rateMissing: true,
        missingRateCurrency: asked.lookup.currency,
      };
    }
    const reference = freezeReference(
      priced,
      currency,
      asked?.lookup.toDigits ?? 2,
      asked?.lookup.rate ?? null,
    );
    return {
      ...resolved,
      currency,
      referenceCurrency: reference.referenceCurrency,
      referencePriceInPlan: reference.referencePriceInPlan,
      rate: reference.referenceRate,
      rateMissing: false,
      missingRateCurrency: null,
    };
  }
}
