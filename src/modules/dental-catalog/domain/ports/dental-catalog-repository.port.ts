import { CatalogKind } from '@prisma/client';
import { DentalCatalogItem } from '../entities/dental-catalog-item.entity';

export interface CreateDentalCatalogItemRepoInput {
  code: string;
  category?: string;
  kind: CatalogKind;
  labelEs: string;
  labelEn?: string;
  labelPt?: string;
  color: string;
  defaultPrice?: number;
  active?: boolean;
}

export interface UpdateDentalCatalogItemRepoInput {
  code?: string;
  category?: string | null;
  kind?: CatalogKind;
  labelEs?: string;
  labelEn?: string | null;
  labelPt?: string | null;
  color?: string;
  defaultPrice?: number | null;
  active?: boolean;
}

export interface ListDentalCatalogItemsParams {
  kind?: CatalogKind;
  activeOnly?: boolean;
}

export const DENTAL_CATALOG_REPOSITORY = Symbol('DENTAL_CATALOG_REPOSITORY');

export interface DentalCatalogRepository {
  create(input: CreateDentalCatalogItemRepoInput): Promise<DentalCatalogItem>;
  list(params: ListDentalCatalogItemsParams): Promise<DentalCatalogItem[]>;
  findById(id: string): Promise<DentalCatalogItem | null>;
  update(
    id: string,
    patch: UpdateDentalCatalogItemRepoInput,
  ): Promise<DentalCatalogItem>;
}
