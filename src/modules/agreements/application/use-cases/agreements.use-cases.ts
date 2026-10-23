import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AgreementKind } from '@prisma/client';
import { Agreement } from '../../domain/entities/agreement.entity';
import {
  AGREEMENT_REPOSITORY,
  type AgreementRepository,
  type UpdateAgreementRepoInput,
} from '../../domain/ports/agreement-repository.port';
import {
  AGREEMENT_DUPLICATE_MESSAGE,
  AGREEMENT_IN_USE_MESSAGE,
  AGREEMENT_LOCATION_NOT_FOUND_MESSAGE,
  AGREEMENT_NOT_FOUND_MESSAGE,
  AGREEMENT_PAYER_INACTIVE_MESSAGE,
  AGREEMENT_PAYER_NOT_FOUND_MESSAGE,
  AGREEMENT_PRICE_LIST_INACTIVE_MESSAGE,
  AGREEMENT_PRICE_LIST_NOT_FOUND_MESSAGE,
  agreementNameKey,
  matchCategories,
  normalizeAgreementName,
  validateAgreementDates,
  validateAgreementName,
  validateAgreementShape,
} from '../../domain/agreement-rules';
import { PAYER_REPOSITORY } from '../../../payers/domain/ports/payer-repository.port';
import type { PayerRepository } from '../../../payers/domain/ports/payer-repository.port';
import { PRICE_LIST_REPOSITORY } from '../../../price-lists/domain/ports/price-list-repository.port';
import type { PriceListRepository } from '../../../price-lists/domain/ports/price-list-repository.port';
import { LOCATION_REPOSITORY } from '../../../locations/domain/ports/location-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import { DENTAL_CATALOG_REPOSITORY } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';

// Los mensajes viven en el dominio; se reexportan aquí porque es el sitio donde
// los busca quien consume el módulo (mismo molde que `payers`).
export {
  AGREEMENT_DUPLICATE_MESSAGE,
  AGREEMENT_IN_USE_MESSAGE,
  AGREEMENT_NOT_FOUND_MESSAGE,
};

export interface CreateAgreementInput {
  name: string;
  payerId: string;
  kind: AgreementKind;
  percent?: number | null;
  percentByCategory?: Record<string, number> | null;
  priceListId?: string | null;
  locationId?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  active?: boolean;
}

export interface UpdateAgreementInput {
  name?: string;
  payerId?: string;
  kind?: AgreementKind;
  percent?: number | null;
  percentByCategory?: Record<string, number> | null;
  priceListId?: string | null;
  locationId?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  active?: boolean;
}

function assertValid(error: string | null): void {
  if (error !== null) throw new BadRequestException(error);
}

/** Un mapa vacío no dice nada: se guarda como «sin porcentajes por categoría». */
function emptyToNull(
  map: Record<string, number> | null | undefined,
): Record<string, number> | null {
  return map && Object.keys(map).length > 0 ? map : null;
}

/** Un convenio que no es de esta clínica (RLS) o está retirado: 404 para ambos. */
async function requireAgreement(
  repo: AgreementRepository,
  id: string,
): Promise<Agreement> {
  const agreement = await repo.findById(id);
  if (!agreement) throw new NotFoundException(AGREEMENT_NOT_FOUND_MESSAGE);
  return agreement;
}

/** Pagador vivo y activo de ESTA clínica (RLS) o 400. */
async function assertPayerUsable(
  payers: PayerRepository,
  payerId: string,
): Promise<void> {
  const payer = await payers.findById(payerId);
  if (!payer) throw new BadRequestException(AGREEMENT_PAYER_NOT_FOUND_MESSAGE);
  if (!payer.active) {
    throw new BadRequestException(AGREEMENT_PAYER_INACTIVE_MESSAGE);
  }
}

/** Lista de precios viva y activa de ESTA clínica (RLS) o 400. */
async function assertPriceListUsable(
  priceLists: PriceListRepository,
  priceListId: string,
): Promise<void> {
  const list = await priceLists.findById(priceListId);
  if (!list) {
    throw new BadRequestException(AGREEMENT_PRICE_LIST_NOT_FOUND_MESSAGE);
  }
  if (!list.active) {
    throw new BadRequestException(AGREEMENT_PRICE_LIST_INACTIVE_MESSAGE);
  }
}

/** La sede del cliente tiene que ser una sede viva de ESTA clínica (RLS). */
async function assertLocationInClinic(
  locations: LocationRepository,
  locationId: string,
): Promise<void> {
  if (!(await locations.findById(locationId))) {
    throw new BadRequestException(AGREEMENT_LOCATION_NOT_FOUND_MESSAGE);
  }
}

/** Categorías del catálogo activo (texto libre, tal como están escritas). */
async function catalogCategories(
  catalog: DentalCatalogRepository,
): Promise<string[]> {
  const items = await catalog.list({ activeOnly: true });
  return items.flatMap((i) => (i.category ? [i.category] : []));
}

/**
 * Valida los porcentajes por categoría contra el catálogo y los devuelve con la
 * ortografía de la categoría del catálogo. `null` si no hay.
 */
async function canonicalPercentByCategory(
  catalog: DentalCatalogRepository,
  map: Record<string, number> | null,
): Promise<Record<string, number> | null> {
  if (map === null) return null;
  const matched = matchCategories(map, await catalogCategories(catalog));
  if (matched.error !== null) throw new BadRequestException(matched.error);
  return matched.value;
}

@Injectable()
export class ListAgreementsUseCase {
  constructor(
    @Inject(AGREEMENT_REPOSITORY) private readonly repo: AgreementRepository,
  ) {}

  /** Por defecto solo los activos. */
  execute(params: { includeInactive?: boolean }): Promise<Agreement[]> {
    return this.repo.list({ includeInactive: params.includeInactive ?? false });
  }
}

@Injectable()
export class CreateAgreementUseCase {
  constructor(
    @Inject(AGREEMENT_REPOSITORY) private readonly repo: AgreementRepository,
    @Inject(PAYER_REPOSITORY) private readonly payers: PayerRepository,
    @Inject(PRICE_LIST_REPOSITORY)
    private readonly priceLists: PriceListRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly catalog: DentalCatalogRepository,
  ) {}

  async execute(
    input: CreateAgreementInput,
    createdById?: string,
  ): Promise<Agreement> {
    assertValid(validateAgreementName(input.name));
    const name = normalizeAgreementName(input.name);

    const percent = input.percent ?? null;
    const requested = emptyToNull(input.percentByCategory);
    const priceListId = input.priceListId ?? null;
    assertValid(
      validateAgreementShape({
        kind: input.kind,
        percent,
        percentByCategory: requested,
        priceListId,
      }),
    );
    const validFrom = input.validFrom ?? null;
    const validTo = input.validTo ?? null;
    assertValid(validateAgreementDates(validFrom, validTo));
    const percentByCategory = await canonicalPercentByCategory(
      this.catalog,
      requested,
    );

    await assertPayerUsable(this.payers, input.payerId);
    if (priceListId !== null) {
      await assertPriceListUsable(this.priceLists, priceListId);
    }
    const locationId = input.locationId ?? null;
    if (locationId !== null) {
      await assertLocationInClinic(this.locations, locationId);
    }
    if (await this.repo.findByNormalizedName(agreementNameKey(name))) {
      throw new ConflictException(AGREEMENT_DUPLICATE_MESSAGE);
    }

    return this.repo.create({
      name,
      payerId: input.payerId,
      kind: input.kind,
      percent,
      percentByCategory,
      priceListId,
      locationId,
      validFrom,
      validTo,
      active: input.active ?? true,
      createdById,
    });
  }
}

@Injectable()
export class UpdateAgreementUseCase {
  constructor(
    @Inject(AGREEMENT_REPOSITORY) private readonly repo: AgreementRepository,
    @Inject(PAYER_REPOSITORY) private readonly payers: PayerRepository,
    @Inject(PRICE_LIST_REPOSITORY)
    private readonly priceLists: PriceListRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly catalog: DentalCatalogRepository,
  ) {}

  /**
   * Las mismas reglas que el alta, sobre el convenio que quedaría. Al cambiar
   * de `kind` los campos del otro `kind` se vacían y los del nuevo se piden en
   * el cuerpo (un convenio por lista no arrastra el porcentaje de antes). El
   * pagador, la lista y la sede solo se comprueban si cambian: un convenio cuyo
   * pagador se desactivó después sigue pudiéndose renombrar.
   */
  async execute(
    id: string,
    input: UpdateAgreementInput,
    updatedById?: string,
  ): Promise<Agreement> {
    const current = await requireAgreement(this.repo, id);

    const kind = input.kind ?? current.kind;
    const kindChanged = kind !== current.kind;
    const base = kindChanged
      ? { percent: null, percentByCategory: null, priceListId: null }
      : {
          percent: current.percent,
          percentByCategory: current.percentByCategory,
          priceListId: current.priceList?.id ?? null,
        };

    const percent = input.percent !== undefined ? input.percent : base.percent;
    const requestedByCategory =
      input.percentByCategory !== undefined
        ? emptyToNull(input.percentByCategory)
        : base.percentByCategory;
    const priceListId =
      input.priceListId !== undefined ? input.priceListId : base.priceListId;
    assertValid(
      validateAgreementShape({
        kind,
        percent,
        percentByCategory: requestedByCategory,
        priceListId,
      }),
    );

    const validFrom =
      input.validFrom !== undefined ? input.validFrom : current.validFrom;
    const validTo =
      input.validTo !== undefined ? input.validTo : current.validTo;
    assertValid(validateAgreementDates(validFrom, validTo));

    const patch: UpdateAgreementRepoInput = {
      kind: kindChanged ? kind : undefined,
      validFrom: input.validFrom,
      validTo: input.validTo,
      active: input.active,
      updatedById,
    };

    if (kindChanged || input.percent !== undefined) patch.percent = percent;
    if (input.percentByCategory !== undefined) {
      // Solo lo que llega se cruza con el catálogo: las categorías ya guardadas
      // no bloquean la edición de otro campo.
      patch.percentByCategory = await canonicalPercentByCategory(
        this.catalog,
        requestedByCategory,
      );
    } else if (kindChanged) {
      patch.percentByCategory = null;
    }

    if (input.name !== undefined) {
      assertValid(validateAgreementName(input.name));
      patch.name = normalizeAgreementName(input.name);
      if (
        await this.repo.findByNormalizedName(agreementNameKey(patch.name), id)
      ) {
        throw new ConflictException(AGREEMENT_DUPLICATE_MESSAGE);
      }
    }
    if (input.payerId !== undefined && input.payerId !== current.payer.id) {
      await assertPayerUsable(this.payers, input.payerId);
      patch.payerId = input.payerId;
    }
    if (priceListId !== (current.priceList?.id ?? null)) {
      if (priceListId !== null) {
        await assertPriceListUsable(this.priceLists, priceListId);
      }
      patch.priceListId = priceListId;
    }
    if (input.locationId !== undefined) {
      if (input.locationId !== null) {
        await assertLocationInClinic(this.locations, input.locationId);
      }
      patch.locationId = input.locationId;
    }

    const updated = await this.repo.update(id, patch);
    if (!updated) throw new NotFoundException(AGREEMENT_NOT_FOUND_MESSAGE);
    return updated;
  }
}

@Injectable()
export class DeleteAgreementUseCase {
  constructor(
    @Inject(AGREEMENT_REPOSITORY) private readonly repo: AgreementRepository,
  ) {}

  /** Con pacientes asignados no se retira: se desactiva. */
  async execute(id: string, deletedById?: string): Promise<void> {
    const result = await this.repo.retire(id, deletedById);
    if (result === 'NOT_FOUND') {
      throw new NotFoundException(AGREEMENT_NOT_FOUND_MESSAGE);
    }
    if (result === 'IN_USE') {
      throw new ConflictException(AGREEMENT_IN_USE_MESSAGE);
    }
  }
}
