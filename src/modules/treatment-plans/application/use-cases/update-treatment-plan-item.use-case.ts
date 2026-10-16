import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CatalogKind, TreatmentPlanItemStatus } from '@prisma/client';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type {
  DoneMirrorInput,
  TreatmentPlanRepository,
  UpdateTreatmentPlanItemRepoInput,
} from '../../domain/ports/treatment-plan-repository.port';
import { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';
import { DENTAL_CATALOG_REPOSITORY } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import { SIGNED_PLAN_LOCKED_MESSAGE } from './signed-plan-lock';
import { assertDiscountWithinPrice } from './item-discount';

export type UpdateTreatmentPlanItemInput = UpdateTreatmentPlanItemRepoInput;

@Injectable()
export class UpdateTreatmentPlanItemUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly catalog: DentalCatalogRepository,
  ) {}

  async execute(
    itemId: string,
    patch: UpdateTreatmentPlanItemInput,
    performedById?: string,
  ): Promise<TreatmentPlanItem> {
    const existing = await this.repo.findItemById(itemId);
    if (!existing) {
      throw new NotFoundException('Treatment plan item not found');
    }

    // Plan aceptado con firma (DX-012): lo firmado (precio, descuento, caras,
    // notas) no cambia y el ítem no vuelve a propuesto; avanzar el tratamiento
    // (aceptado <-> realizado) sí.
    const plan = await this.repo.findPlanById(existing.planId);
    if (
      plan?.acceptance &&
      (patch.price !== undefined ||
        patch.discount !== undefined ||
        patch.surfaces !== undefined ||
        patch.notes !== undefined ||
        patch.status === TreatmentPlanItemStatus.PROPOSED)
    ) {
      throw new ConflictException(SIGNED_PLAN_LOCKED_MESSAGE);
    }
    if (patch.price !== undefined || patch.discount !== undefined) {
      assertDiscountWithinPrice(
        patch.price ?? existing.price,
        patch.discount ?? existing.discount,
      );
    }

    // Pieza B: a (PROPOSED|ACCEPTED) -> DONE transition mirrors the procedure
    // into the odontogram — same tooth/surfaces/catalog item, status COMPLETED,
    // linked back via `sourcePlanItemId`. DX-042 (DB-013): the repository does
    // the transition AND the insert in ONE transaction with the item locked,
    // so two concurrent DONE never mirror twice and a failed mirror never
    // leaves the item DONE without its clinical record. Tooth records are
    // append-only: reverting a DONE item does not remove the record (a done
    // procedure is history).
    const mirror =
      patch.status === TreatmentPlanItemStatus.DONE &&
      existing.status !== TreatmentPlanItemStatus.DONE &&
      plan
        ? await this.mirrorInput(existing, plan.patientId, performedById)
        : undefined;

    return this.repo.updateItem(itemId, patch, mirror);
  }

  private async mirrorInput(
    item: TreatmentPlanItem,
    // The item has planId but not patientId; it comes from the plan.
    patientId: string,
    performedById?: string,
  ): Promise<DoneMirrorInput> {
    // ToothRecord requires `kind`; the item doesn't store it — take it from the
    // catalog item, defaulting to PROCEDURE (plan items are procedures).
    const catalogItem = await this.catalog.findById(item.catalogItemId);
    return {
      patientId,
      kind: catalogItem?.kind ?? CatalogKind.PROCEDURE,
      performedById,
    };
  }
}
