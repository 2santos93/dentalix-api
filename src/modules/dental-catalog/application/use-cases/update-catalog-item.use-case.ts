import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DENTAL_CATALOG_REPOSITORY } from '../../domain/ports/dental-catalog-repository.port';
import type {
  DentalCatalogRepository,
  UpdateDentalCatalogItemRepoInput,
} from '../../domain/ports/dental-catalog-repository.port';
import { DentalCatalogItem } from '../../domain/entities/dental-catalog-item.entity';
import {
  isValidCatalogKind,
  isValidHexColor,
} from './create-catalog-item.use-case';

export type UpdateCatalogItemInput = UpdateDentalCatalogItemRepoInput;

@Injectable()
export class UpdateCatalogItemUseCase {
  constructor(
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly repo: DentalCatalogRepository,
  ) {}

  async execute(
    id: string,
    patch: UpdateCatalogItemInput,
  ): Promise<DentalCatalogItem> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      // Same rationale as patients: a missing row and a row that belongs to
      // another tenant are indistinguishable here (RLS makes cross-tenant
      // rows invisible), so both surface as NotFound.
      throw new NotFoundException('Catalog item not found');
    }

    if (patch.color !== undefined && !isValidHexColor(patch.color)) {
      throw new BadRequestException(
        'color must be a valid hex value (e.g. #1A2B3C)',
      );
    }
    if (patch.kind !== undefined && !isValidCatalogKind(patch.kind)) {
      throw new BadRequestException(
        'kind must be one of: DIAGNOSIS, PROCEDURE',
      );
    }

    const normalizedPatch: UpdateDentalCatalogItemRepoInput = { ...patch };
    if (normalizedPatch.code !== undefined) {
      normalizedPatch.code = normalizedPatch.code.trim();
    }

    return this.repo.update(id, normalizedPatch);
  }
}
