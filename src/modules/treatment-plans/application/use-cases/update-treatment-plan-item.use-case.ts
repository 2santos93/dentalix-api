import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CatalogKind,
  DiscountReason,
  TreatmentPlanItemStatus,
} from '@prisma/client';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type {
  DoneMirrorInput,
  TreatmentPlanRepository,
  UpdateTreatmentPlanItemRepoInput,
} from '../../domain/ports/treatment-plan-repository.port';
import { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';
import { DENTAL_CATALOG_REPOSITORY } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogRepository } from '../../../dental-catalog/domain/ports/dental-catalog-repository.port';
import {
  SIGNED_PLAN_LOCKED_MESSAGE,
  assertPlanOpenForItems,
} from './signed-plan-lock';
import {
  assertDiscountWithinPrice,
  assertPlanDiscountable,
  decideDiscount,
  type DiscountActor,
} from './item-discount';
import { isClosedPlanItemChangeAllowed } from '../../domain/plan-status-machine';
import { GetDiscountPolicyUseCase } from '../../../discounts/application/use-cases/discount-policy.use-cases';
import { TREATMENT_PLAN_CLOCK, type PlanClock } from '../plan-clock';

export interface UpdateTreatmentPlanItemInput {
  price?: number;
  discount?: number;
  status?: TreatmentPlanItemStatus;
  surfaces?: UpdateTreatmentPlanItemRepoInput['surfaces'];
  notes?: string | null;
  /** DX-204: `null` quita el motivo (y su nota). */
  discountReason?: DiscountReason | null;
  discountReasonNote?: string | null;
}

/**
 * ¿Cambia el descuento del ítem (DX-204)? El importe, el motivo o su nota; o el
 * precio de un ítem con descuento (cambia su %). Un cambio así se valida contra
 * la política del rol de quien lo hace y queda a su nombre.
 */
function changesDiscount(
  existing: TreatmentPlanItem,
  patch: UpdateTreatmentPlanItemInput,
): boolean {
  const discount = patch.discount ?? existing.discount;
  return (
    discount !== existing.discount ||
    (patch.price !== undefined &&
      patch.price !== existing.price &&
      discount > 0) ||
    (patch.discountReason !== undefined &&
      patch.discountReason !== existing.discountReason) ||
    (patch.discountReasonNote !== undefined &&
      (patch.discountReasonNote?.trim() || null) !==
        existing.discountReasonNote)
  );
}

@Injectable()
export class UpdateTreatmentPlanItemUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly catalog: DentalCatalogRepository,
    private readonly discountPolicy: GetDiscountPolicyUseCase,
    @Inject(TREATMENT_PLAN_CLOCK)
    private readonly now: PlanClock,
  ) {}

  /**
   * `actor` es el usuario del token: decide el tope del descuento (DX-204) y
   * firma el registro del odontograma que crea marcar el ítem como realizado.
   */
  async execute(
    itemId: string,
    patch: UpdateTreatmentPlanItemInput,
    actor: DiscountActor,
  ): Promise<TreatmentPlanItem> {
    const existing = await this.repo.findItemById(itemId);
    if (!existing) {
      throw new NotFoundException('Treatment plan item not found');
    }

    // Plan aceptado con firma (DX-012): lo firmado (precio, descuento, caras,
    // notas) no cambia y el ítem no vuelve a propuesto; avanzar el tratamiento
    // (aceptado <-> realizado) sí.
    const plan = await this.repo.findPlanById(existing.planId);
    // Plan cerrado (DX-109): nada, salvo marcar como realizado lo que quedó
    // aceptado en un plan completado.
    if (
      plan &&
      !isClosedPlanItemChangeAllowed(plan.status, existing.status, patch)
    ) {
      assertPlanOpenForItems(plan);
    }
    if (
      plan?.acceptance &&
      (patch.price !== undefined ||
        patch.discount !== undefined ||
        patch.discountReason !== undefined ||
        patch.discountReasonNote !== undefined ||
        patch.surfaces !== undefined ||
        patch.notes !== undefined ||
        patch.status === TreatmentPlanItemStatus.PROPOSED)
    ) {
      throw new ConflictException(SIGNED_PLAN_LOCKED_MESSAGE);
    }
    const price = patch.price ?? existing.price;
    const discount = patch.discount ?? existing.discount;
    if (patch.price !== undefined || patch.discount !== undefined) {
      assertDiscountWithinPrice(price, discount);
    }

    const { discountReason, discountReasonNote, ...rest } = patch;
    const repoPatch: UpdateTreatmentPlanItemRepoInput = rest;
    if (plan && changesDiscount(existing, patch)) {
      assertPlanDiscountable(plan);
      // Sin motivo en la petición se conserva el del ítem; cambiar de motivo
      // sin nota borra la nota anterior (era de otro motivo).
      const reason =
        discountReason !== undefined ? discountReason : existing.discountReason;
      const note =
        discountReasonNote !== undefined
          ? discountReasonNote
          : discountReason !== undefined
            ? null
            : existing.discountReasonNote;
      Object.assign(
        repoPatch,
        decideDiscount(
          await this.discountPolicy.execute(),
          actor,
          { price, discount, reason, reasonNote: note },
          this.now(),
        ),
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
        ? await this.mirrorInput(existing, plan.patientId, actor.userId)
        : undefined;

    return this.repo.updateItem(itemId, repoPatch, mirror);
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
