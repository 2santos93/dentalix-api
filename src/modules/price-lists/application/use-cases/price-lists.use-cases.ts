import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CatalogKind } from '@prisma/client';
import { PriceList } from '../../domain/entities/price-list.entity';
import {
  PRICE_LIST_REPOSITORY,
  type PriceListItemInput,
  type PriceListItemsDirectoryPage,
  type PriceListRepository,
  type ReplacePriceListItemsResult,
} from '../../domain/ports/price-list-repository.port';
import {
  duplicatedCatalogItemIds,
  normalizePriceListName,
  PRICE_LIST_CATALOG_ITEMS_MESSAGE,
  PRICE_LIST_CURRENCY_LOCKED_MESSAGE,
  PRICE_LIST_CURRENCY_UNKNOWN_MESSAGE,
  PRICE_LIST_DUPLICATE_MESSAGE,
  PRICE_LIST_DUPLICATED_ITEMS_MESSAGE,
  PRICE_LIST_IN_USE_MESSAGE,
  PRICE_LIST_LOCATION_NOT_FOUND_MESSAGE,
  PRICE_LIST_LOCATION_TAKEN_MESSAGE,
  PRICE_LIST_NOT_FOUND_MESSAGE,
  PRICE_LIST_NOT_PRICEABLE_MESSAGE,
  priceListNameKey,
  validatePriceListName,
} from '../../domain/price-list-rules';
import { CURRENCY_WHITELIST } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import type { CurrencyWhitelist } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import { LOCATION_REPOSITORY } from '../../../locations/domain/ports/location-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import { DENTAL_CATALOG_REPOSITORY } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';

// Los mensajes viven en el dominio; se reexportan aquí porque es el sitio donde
// los busca quien consume el módulo (mismo molde que `payers`).
export {
  PRICE_LIST_CURRENCY_LOCKED_MESSAGE,
  PRICE_LIST_DUPLICATE_MESSAGE,
  PRICE_LIST_IN_USE_MESSAGE,
  PRICE_LIST_LOCATION_TAKEN_MESSAGE,
  PRICE_LIST_NOT_FOUND_MESSAGE,
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface CreatePriceListInput {
  name: string;
  currency: string;
  locationId?: string | null;
}

export interface UpdatePriceListInput {
  name?: string;
  currency?: string;
  locationId?: string | null;
  active?: boolean;
}

export interface ListPriceListItemsInput {
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface ListPriceListItemsOutput extends PriceListItemsDirectoryPage {
  page: number;
  pageSize: number;
}

function assertValid(error: string | null): void {
  if (error !== null) throw new BadRequestException(error);
}

function normalizePage(page?: number): number {
  if (page === undefined || !Number.isFinite(page) || page < 1) {
    return DEFAULT_PAGE;
  }
  return Math.floor(page);
}

function normalizePageSize(pageSize?: number): number {
  if (pageSize === undefined || !Number.isFinite(pageSize) || pageSize < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(pageSize), MAX_PAGE_SIZE);
}

/** Una lista que no es de esta clínica (RLS) o está retirada: 404 para ambos. */
async function requireList(
  repo: PriceListRepository,
  id: string,
): Promise<PriceList> {
  const list = await repo.findById(id);
  if (!list) throw new NotFoundException(PRICE_LIST_NOT_FOUND_MESSAGE);
  return list;
}

async function assertCurrencyKnown(
  whitelist: CurrencyWhitelist,
  currency: string,
): Promise<void> {
  if (!(await whitelist.has(currency))) {
    throw new BadRequestException(PRICE_LIST_CURRENCY_UNKNOWN_MESSAGE);
  }
}

/** La sede del cliente tiene que ser una sede viva de ESTA clínica (RLS). */
async function assertLocationInClinic(
  locations: LocationRepository,
  locationId: string,
): Promise<void> {
  if (!(await locations.findById(locationId))) {
    throw new BadRequestException(PRICE_LIST_LOCATION_NOT_FOUND_MESSAGE);
  }
}

/** A lo sumo una lista ACTIVA por sede: la que quedaría no puede chocar con otra. */
async function assertLocationFree(
  repo: PriceListRepository,
  locationId: string,
  excludeId?: string,
): Promise<void> {
  if (await repo.findActiveByLocation(locationId, excludeId)) {
    throw new ConflictException(PRICE_LIST_LOCATION_TAKEN_MESSAGE);
  }
}

@Injectable()
export class ListPriceListsUseCase {
  constructor(
    @Inject(PRICE_LIST_REPOSITORY) private readonly repo: PriceListRepository,
  ) {}

  /** Por defecto solo las activas. */
  execute(params: { includeInactive?: boolean }): Promise<PriceList[]> {
    return this.repo.list({ includeInactive: params.includeInactive ?? false });
  }
}

@Injectable()
export class CreatePriceListUseCase {
  constructor(
    @Inject(PRICE_LIST_REPOSITORY) private readonly repo: PriceListRepository,
    @Inject(CURRENCY_WHITELIST) private readonly whitelist: CurrencyWhitelist,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
  ) {}

  async execute(
    input: CreatePriceListInput,
    createdById?: string,
  ): Promise<PriceList> {
    assertValid(validatePriceListName(input.name));
    const name = normalizePriceListName(input.name);
    const currency = input.currency.toUpperCase();
    await assertCurrencyKnown(this.whitelist, currency);

    const locationId = input.locationId ?? null;
    if (locationId !== null) {
      await assertLocationInClinic(this.locations, locationId);
    }
    if (await this.repo.findByNormalizedName(priceListNameKey(name))) {
      throw new ConflictException(PRICE_LIST_DUPLICATE_MESSAGE);
    }
    // Se nace activa, así que la sede no puede tener ya otra activa.
    if (locationId !== null) await assertLocationFree(this.repo, locationId);

    return this.repo.create({
      name,
      currency,
      locationId,
      active: true,
      createdById,
    });
  }
}

@Injectable()
export class UpdatePriceListUseCase {
  constructor(
    @Inject(PRICE_LIST_REPOSITORY) private readonly repo: PriceListRepository,
    @Inject(CURRENCY_WHITELIST) private readonly whitelist: CurrencyWhitelist,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
  ) {}

  async execute(
    id: string,
    input: UpdatePriceListInput,
    updatedById?: string,
  ): Promise<PriceList> {
    const current = await requireList(this.repo, id);

    const patch: UpdatePriceListInput = { active: input.active };
    if (input.name !== undefined) {
      assertValid(validatePriceListName(input.name));
      patch.name = normalizePriceListName(input.name);
      const existing = await this.repo.findByNormalizedName(
        priceListNameKey(patch.name),
        id,
      );
      if (existing) throw new ConflictException(PRICE_LIST_DUPLICATE_MESSAGE);
    }
    if (input.currency !== undefined) {
      const currency = input.currency.toUpperCase();
      await assertCurrencyKnown(this.whitelist, currency);
      if (currency !== current.currency) {
        // Con precios cargados, otra moneda dejaría números sin sentido.
        if (current.itemCount > 0) {
          throw new ConflictException(PRICE_LIST_CURRENCY_LOCKED_MESSAGE);
        }
        patch.currency = currency;
      }
    }
    if (input.locationId !== undefined) {
      if (input.locationId !== null) {
        await assertLocationInClinic(this.locations, input.locationId);
      }
      patch.locationId = input.locationId;
    }

    // La lista que quedaría tras el cambio: si es activa y de una sede, esa
    // sede no puede tener otra activa.
    const active = input.active ?? current.active;
    const locationId =
      input.locationId !== undefined ? input.locationId : current.locationId;
    const touchesSlot =
      input.active !== undefined || input.locationId !== undefined;
    if (touchesSlot && active && locationId !== null) {
      await assertLocationFree(this.repo, locationId, id);
    }

    const updated = await this.repo.update(id, { ...patch, updatedById });
    if (!updated) throw new NotFoundException(PRICE_LIST_NOT_FOUND_MESSAGE);
    return updated;
  }
}

@Injectable()
export class DeletePriceListUseCase {
  constructor(
    @Inject(PRICE_LIST_REPOSITORY) private readonly repo: PriceListRepository,
  ) {}

  /** Con un convenio vivo no se retira: se desactiva (el convenio sigue). */
  async execute(id: string, deletedById?: string): Promise<void> {
    const result = await this.repo.retire(id, deletedById);
    if (result === 'NOT_FOUND') {
      throw new NotFoundException(PRICE_LIST_NOT_FOUND_MESSAGE);
    }
    if (result === 'IN_USE') {
      throw new ConflictException(PRICE_LIST_IN_USE_MESSAGE);
    }
  }
}

@Injectable()
export class ListPriceListItemsUseCase {
  constructor(
    @Inject(PRICE_LIST_REPOSITORY) private readonly repo: PriceListRepository,
  ) {}

  /**
   * Una página del catálogo de procedimientos con el precio que cada uno tiene
   * en la lista. Un texto en blanco es «sin búsqueda»: si no, teclear un
   * espacio vaciaría la tabla.
   */
  async execute(
    id: string,
    input: ListPriceListItemsInput = {},
  ): Promise<ListPriceListItemsOutput> {
    await requireList(this.repo, id);
    const page = normalizePage(input.page);
    const pageSize = normalizePageSize(input.pageSize);
    const { items, total } = await this.repo.listItemsDirectory(id, {
      query: input.query?.trim() || undefined,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize };
  }
}

@Injectable()
export class ReplacePriceListItemsUseCase {
  constructor(
    @Inject(PRICE_LIST_REPOSITORY) private readonly repo: PriceListRepository,
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly catalog: DentalCatalogRepository,
  ) {}

  /**
   * Upsert por lote: `price` fija el precio y `null` lo quita. Todas las
   * prestaciones tienen que ser del catálogo de ESTA clínica: una ajena (o
   * inexistente) da 400 y NO se escribe ninguna fila del lote.
   */
  async execute(
    id: string,
    items: PriceListItemInput[],
  ): Promise<ReplacePriceListItemsResult> {
    await requireList(this.repo, id);
    const ids = items.map((i) => i.catalogItemId);
    if (duplicatedCatalogItemIds(ids).length > 0) {
      throw new BadRequestException(PRICE_LIST_DUPLICATED_ITEMS_MESSAGE);
    }
    if (ids.length > 0) {
      const found = await this.catalog.findByIds(ids);
      if (found.length !== ids.length) {
        throw new BadRequestException(PRICE_LIST_CATALOG_ITEMS_MESSAGE);
      }
      // Fijar un precio exige un procedimiento activo (el directorio solo
      // muestra esos); quitar uno heredado sí se permite.
      const priced = new Set(
        items.filter((i) => i.price !== null).map((i) => i.catalogItemId),
      );
      if (
        found.some(
          (c) =>
            priced.has(c.id) && (!c.active || c.kind !== CatalogKind.PROCEDURE),
        )
      ) {
        throw new BadRequestException(PRICE_LIST_NOT_PRICEABLE_MESSAGE);
      }
    }
    return this.repo.replaceItems(id, items);
  }
}
