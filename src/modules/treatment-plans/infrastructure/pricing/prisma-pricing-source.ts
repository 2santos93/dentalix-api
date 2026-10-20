import { Inject, Injectable } from '@nestjs/common';
import { AgreementKind } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../../shared/time/civil-day';
import {
  DENTAL_CATALOG_REPOSITORY,
  type DentalCatalogRepository,
} from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import {
  PRICE_LIST_REPOSITORY,
  type PriceListRepository,
} from '../../../price-lists/domain/ports/price-list-repository.port';
import {
  AGREEMENT_REPOSITORY,
  type AgreementRepository,
} from '../../../agreements/domain/ports/agreement-repository.port';
import type { Agreement } from '../../../agreements/domain/entities/agreement.entity';
import {
  PATIENT_AGREEMENT_REPOSITORY,
  type PatientAgreementRepository,
} from '../../../patient-agreements/domain/ports/patient-agreement-repository.port';
import type { PricingSource } from '../../domain/ports/pricing-source.port';
import type { PricingContext } from '../../domain/pricing/resolve-item-price';
import {
  TREATMENT_PLAN_CLOCK,
  type PlanClock,
} from '../../application/plan-clock';

/**
 * `PricingSource` sobre los repositorios de catálogo, listas, convenios y
 * asignaciones (DX-105), cada uno bajo su `runWithTenant` (RLS). No re-implementa
 * sus consultas: las compone. La sede y «hoy» salen de una transacción propia
 * con `writeLocationId` (un miembro restringido sin sede activa: 403, igual que
 * al sellar el descuento).
 */
@Injectable()
export class PrismaPricingSource implements PricingSource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly catalog: DentalCatalogRepository,
    @Inject(PRICE_LIST_REPOSITORY)
    private readonly priceLists: PriceListRepository,
    @Inject(AGREEMENT_REPOSITORY)
    private readonly agreements: AgreementRepository,
    @Inject(PATIENT_AGREEMENT_REPOSITORY)
    private readonly assignments: PatientAgreementRepository,
    @Inject(TREATMENT_PLAN_CLOCK)
    private readonly now: PlanClock,
  ) {}

  async contextFor(
    patientId: string,
    catalogItemId: string,
    planCurrency: string,
  ): Promise<PricingContext | null> {
    const catalogItem = await this.catalog.findById(catalogItemId);
    if (!catalogItem) return null;

    const { locationId, today } = await this.writeLocationAndToday();
    const assignment = await this.assignments.currentLiveByPatient(patientId);
    // `findLiveById` no devuelve retirados: un convenio retirado no aplica.
    const agreement = assignment
      ? await this.agreements.findLiveById(assignment.agreementId)
      : null;

    return {
      catalogItem: {
        defaultPrice: catalogItem.defaultPrice,
        category: catalogItem.category,
        allowDiscount: catalogItem.allowDiscount,
      },
      planCurrency,
      today,
      locationId,
      agreement:
        agreement && assignment
          ? {
              id: agreement.id,
              name: agreement.name,
              kind: agreement.kind,
              percent: agreement.percent,
              percentByCategory: agreement.percentByCategory,
              priceListId: agreement.priceList?.id ?? null,
              locationId: agreement.locationId,
              active: agreement.active,
              validFrom: agreement.validFrom,
              validTo: agreement.validTo,
              assignmentValidFrom: assignment.validFrom,
              assignmentValidTo: assignment.validTo,
            }
          : null,
      agreementListPrice: await this.agreementListPrice(
        agreement,
        catalogItemId,
      ),
      locationList: await this.locationList(locationId, catalogItemId),
    };
  }

  /** Sede de escritura del request y su día civil de hoy (R8). */
  private writeLocationAndToday(): Promise<{
    locationId: string;
    today: string;
  }> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return this.prisma.runWithTenant(async (tx) => {
      const locationId = await this.tenantContext.writeLocationId(tx);
      const zoneOf = await resolveLocationTimeZones(tx, tenantId, [locationId]);
      return { locationId, today: civilDateIn(this.now(), zoneOf(locationId)) };
    });
  }

  /**
   * Precio del ítem en la lista de un convenio `PRICE_LIST`, con la moneda y el
   * estado de la lista. `priceFor` no mira si la lista está retirada: solo se
   * le pregunta por una lista que `findById` aún devuelve (viva).
   */
  private async agreementListPrice(
    agreement: Agreement | null,
    catalogItemId: string,
  ): Promise<PricingContext['agreementListPrice']> {
    if (agreement?.kind !== AgreementKind.PRICE_LIST || !agreement.priceList) {
      return null;
    }
    const list = await this.priceLists.findById(agreement.priceList.id);
    if (!list) return null;
    const price = await this.priceLists.priceFor(list.id, catalogItemId);
    return price === null
      ? null
      : { price, currency: list.currency, active: list.active };
  }

  /** Lista activa y viva de la sede, con el precio del ítem o `null`. */
  private async locationList(
    locationId: string,
    catalogItemId: string,
  ): Promise<PricingContext['locationList']> {
    const list = await this.priceLists.activeListForLocation(locationId);
    if (!list) return null;
    return {
      currency: list.currency,
      price: await this.priceLists.priceFor(list.id, catalogItemId),
    };
  }
}
