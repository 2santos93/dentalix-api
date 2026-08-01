import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CatalogKind,
  ToothRecordStatus,
  TreatmentPlanItemStatus,
} from '@prisma/client';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type {
  TreatmentPlanRepository,
  UpdateTreatmentPlanItemRepoInput,
} from '../../domain/ports/treatment-plan-repository.port';
import { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';
import { TOOTH_RECORD_REPOSITORY } from '../../../odontogram/domain/ports/tooth-record-repository.port';
import type { ToothRecordRepository } from '../../../odontogram/domain/ports/tooth-record-repository.port';
import { DENTAL_CATALOG_REPOSITORY } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';

export type UpdateTreatmentPlanItemInput = UpdateTreatmentPlanItemRepoInput;

@Injectable()
export class UpdateTreatmentPlanItemUseCase {
  private readonly logger = new Logger(UpdateTreatmentPlanItemUseCase.name);

  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
    @Inject(TOOTH_RECORD_REPOSITORY)
    private readonly toothRecords: ToothRecordRepository,
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

    const updated = await this.repo.updateItem(itemId, patch);

    // Pieza B: a (PROPOSED|ACCEPTED) -> DONE transition mirrors the procedure
    // into the odontogram — same tooth/surfaces/catalog item, status COMPLETED,
    // linked back via `sourcePlanItemId`. Best-effort: updating the plan item is
    // the primary operation, so a mirroring failure is logged, never thrown
    // (the PATCH still succeeds). Tooth records are append-only, so this only
    // ever CREATES — reverting a DONE item does not remove the record (a done
    // procedure is history).
    const becameDone =
      existing.status !== TreatmentPlanItemStatus.DONE &&
      updated.status === TreatmentPlanItemStatus.DONE;
    if (becameDone) {
      await this.mirrorToOdontogram(updated, performedById).catch(
        (err: unknown) => {
          this.logger.warn(
            `No se pudo reflejar el ítem ${updated.id} en el odontograma: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        },
      );
    }

    return updated;
  }

  private async mirrorToOdontogram(
    item: TreatmentPlanItem,
    performedById?: string,
  ): Promise<void> {
    // Dedupe: mirror each plan item at most once (idempotent on re-marking DONE).
    const already = await this.toothRecords.findBySourcePlanItem(item.id);
    if (already) return;

    // The item has planId but not patientId; resolve it via the plan.
    const plan = await this.repo.findPlanById(item.planId);
    if (!plan) return;

    // ToothRecord requires `kind`; the item doesn't store it — take it from the
    // catalog item, defaulting to PROCEDURE (plan items are procedures).
    const catalogItem = await this.catalog.findById(item.catalogItemId);
    const kind = catalogItem?.kind ?? CatalogKind.PROCEDURE;

    await this.toothRecords.create({
      patientId: plan.patientId,
      toothNumber: item.toothNumber,
      surfaces: item.surfaces,
      kind,
      catalogItemId: item.catalogItemId,
      status: ToothRecordStatus.COMPLETED,
      performedById,
      sourcePlanItemId: item.id,
    });
  }
}
