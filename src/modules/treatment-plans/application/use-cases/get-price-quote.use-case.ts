import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PriceSource } from '@prisma/client';
import {
  PRICING_SOURCE,
  type PricingSource,
} from '../../domain/ports/pricing-source.port';
import { resolveItemPrice } from '../../domain/pricing/resolve-item-price';
import {
  PATIENT_AGREEMENT_REPOSITORY,
  type PatientAgreementRepository,
} from '../../../patient-agreements/domain/ports/patient-agreement-repository.port';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patient-coverages/domain/coverage-rules';

export const PRICE_QUOTE_CATALOG_ITEM_NOT_FOUND_MESSAGE =
  'Procedimiento no encontrado.';

/** Precio que tendría el ítem si se añadiera ahora (DX-105 §4.2). */
export interface PriceQuote {
  basePrice: number | null;
  price: number | null;
  source: PriceSource;
  agreementId: string | null;
  agreementName: string | null;
  allowDiscount: boolean;
  currency: string;
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
  ) {}

  async execute(
    patientId: string,
    catalogItemId: string,
    currency: string,
  ): Promise<PriceQuote> {
    if (!(await this.patients.patientExists(patientId))) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    const context = await this.pricing.contextFor(
      patientId,
      catalogItemId,
      currency,
    );
    if (!context) {
      throw new NotFoundException(PRICE_QUOTE_CATALOG_ITEM_NOT_FOUND_MESSAGE);
    }
    return { ...resolveItemPrice(context), currency };
  }
}
