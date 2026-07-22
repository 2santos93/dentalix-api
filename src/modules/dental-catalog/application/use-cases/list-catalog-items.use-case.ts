import { Inject, Injectable } from '@nestjs/common';
import { CatalogKind } from '@prisma/client';
import { DENTAL_CATALOG_REPOSITORY } from '../../domain/ports/dental-catalog-repository.port';
import type { DentalCatalogRepository } from '../../domain/ports/dental-catalog-repository.port';
import { DentalCatalogItem } from '../../domain/entities/dental-catalog-item.entity';

export interface ListCatalogItemsInput {
  kind?: CatalogKind;
  activeOnly?: boolean;
}

@Injectable()
export class ListCatalogItemsUseCase {
  constructor(
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly repo: DentalCatalogRepository,
  ) {}

  async execute(input: ListCatalogItemsInput): Promise<DentalCatalogItem[]> {
    return this.repo.list({
      kind: input.kind,
      activeOnly: input.activeOnly,
    });
  }
}
