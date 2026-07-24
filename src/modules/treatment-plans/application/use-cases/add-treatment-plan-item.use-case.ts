import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ToothSurface } from '@prisma/client';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type { TreatmentPlanRepository } from '../../domain/ports/treatment-plan-repository.port';
import { DENTAL_CATALOG_REPOSITORY } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';

// NOTE: deliberately NO `tenantId`/`id`/`status` field — a new item always
// starts PROPOSED (the schema default). `price` is OPTIONAL: when omitted,
// it is resolved from the catalog item's `defaultPrice` (see `execute`).
export interface AddTreatmentPlanItemInput {
  toothNumber: string;
  surfaces?: ToothSurface[];
  catalogItemId: string;
  price?: number;
  notes?: string;
}

@Injectable()
export class AddTreatmentPlanItemUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly catalogRepo: DentalCatalogRepository,
  ) {}

  async execute(
    planId: string,
    input: AddTreatmentPlanItemInput,
  ): Promise<TreatmentPlanItem> {
    const plan = await this.repo.findPlanById(planId);
    if (!plan) {
      throw new NotFoundException('Treatment plan not found');
    }

    // `catalogItemId` must resolve to a real, active-tenant catalog item —
    // a cross-tenant or made-up id must never silently succeed (that would
    // let an item reference a procedure the tenant can't see/bill).
    const catalogItem = await this.catalogRepo.findById(input.catalogItemId);
    if (!catalogItem) {
      throw new NotFoundException('Catalog item not found');
    }

    // Explicit price wins; otherwise fall back to the catalog item's
    // defaultPrice. If neither is available, the item has no price at all —
    // that's a client error (400), not a server error.
    const price = input.price ?? catalogItem.defaultPrice ?? undefined;
    if (price === undefined) {
      throw new BadRequestException('price is required');
    }

    return this.repo.addItem({
      planId,
      toothNumber: input.toothNumber,
      surfaces: input.surfaces,
      catalogItemId: input.catalogItemId,
      price,
      notes: input.notes,
    });
  }
}
