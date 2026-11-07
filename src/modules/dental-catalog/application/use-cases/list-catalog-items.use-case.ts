import { Inject, Injectable } from '@nestjs/common';
import { CatalogKind } from '@prisma/client';
import { DENTAL_CATALOG_REPOSITORY } from '../../domain/ports/dental-catalog-repository.port';
import type { DentalCatalogRepository } from '../../domain/ports/dental-catalog-repository.port';
import { DentalCatalogItem } from '../../domain/entities/dental-catalog-item.entity';
import {
  CATALOG_CURRENCY_READER,
  type CatalogCurrencyReader,
} from '../../domain/ports/catalog-currency-reader.port';

/**
 * DX-502-ter: cada ítem lleva la moneda del catálogo de la clínica, la de su
 * `defaultPrice` (`null` si no se sabe). La lista es un arreglo, así que es el
 * único sitio donde cabe sin romper el contrato; es la misma para todos.
 */
export type CatalogItemWithCurrency = DentalCatalogItem & {
  catalogCurrency: string | null;
};

export interface ListCatalogItemsInput {
  kind?: CatalogKind;
  activeOnly?: boolean;
}

@Injectable()
export class ListCatalogItemsUseCase {
  constructor(
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly repo: DentalCatalogRepository,
    @Inject(CATALOG_CURRENCY_READER)
    private readonly currency: CatalogCurrencyReader,
  ) {}

  async execute(
    input: ListCatalogItemsInput,
  ): Promise<CatalogItemWithCurrency[]> {
    const [items, catalogCurrency] = await Promise.all([
      this.repo.list({ kind: input.kind, activeOnly: input.activeOnly }),
      this.currency.current(),
    ]);
    return items.map((item) => ({ ...item, catalogCurrency }));
  }
}
