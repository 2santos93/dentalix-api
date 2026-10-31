import {
  BadRequestException,
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
  assertDiscountAllowed,
  assertDiscountWithinPrice,
  assertPlanDiscountable,
  decideDiscountChange,
  touchesDiscount,
  type DiscountActor,
} from './item-discount';
import {
  DONE_ITEM_PRICE_LOCKED_MESSAGE,
  isClosedPlanItemChangeAllowed,
  isDoneItemPriceChange,
} from '../../domain/plan-status-machine';
import {
  APPOINTMENT_ONLY_WHEN_MARKING_DONE_MESSAGE,
  decideAttribution,
  isAttributionCorrection,
} from '../../domain/plan-item-attribution';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { effectiveDiscountRises } from '../../../discounts/domain/effective-discount';
import { GetDiscountPolicyUseCase } from '../../../discounts/application/use-cases/discount-policy.use-cases';
import { TREATMENT_PLAN_CLOCK, type PlanClock } from '../plan-clock';
import { FEE_ITEM_LOCKED_MESSAGE } from '../../../cancellation-fees/domain/cancellation-fee';

export interface UpdateTreatmentPlanItemInput {
  price?: number;
  discount?: number;
  status?: TreatmentPlanItemStatus;
  surfaces?: UpdateTreatmentPlanItemRepoInput['surfaces'];
  notes?: string | null;
  /** DX-204: `null` quita el motivo (y su nota). */
  discountReason?: DiscountReason | null;
  discountReasonNote?: string | null;
  /**
   * DX-050: quién lo realizó (usuario). Al pasar a DONE, por defecto quien
   * marca si atiende; en un ítem ya DONE, solo un ADMIN lo cambia.
   */
  performedById?: string;
  /** DX-050: solo un ADMIN corrige la fecha de un ítem ya DONE. */
  completedAt?: Date;
  /**
   * DX-305: solo un ADMIN corrige la sede de un ítem ya DONE; obligatoria al
   * atribuir uno «Sin atribuir» (con quién y cuándo).
   */
  performedLocationId?: string;
  /**
   * DX-439: al pasar a DONE desde «Pendiente de cerrar», la cita atendida que
   * lleva el ítem: la sede y la fecha de realización son las suyas.
   */
  appointmentId?: string;
}

/** ¿La petición pone otro `discount` o cambia el motivo o su nota? (DX-204) */
function discountFieldChanges(
  existing: TreatmentPlanItem,
  patch: UpdateTreatmentPlanItemInput,
): { discountSet: boolean; reasonChanged: boolean } {
  return {
    discountSet:
      patch.discount !== undefined && patch.discount !== existing.discount,
    reasonChanged:
      (patch.discountReason !== undefined &&
        patch.discountReason !== existing.discountReason) ||
      (patch.discountReasonNote !== undefined &&
        (patch.discountReasonNote?.trim() || null) !==
          existing.discountReasonNote),
  };
}

/**
 * SEC-050: ¿la petición cambia el dinero o el estado del ítem? En el de un
 * cargo vigente eso sería rebajarlo o condonarlo por fuera de su flujo.
 */
function touchesFeeItem(
  item: TreatmentPlanItem,
  patch: UpdateTreatmentPlanItemInput,
): boolean {
  const { discountSet, reasonChanged } = discountFieldChanges(item, patch);
  return (
    (patch.price !== undefined && patch.price !== item.price) ||
    discountSet ||
    reasonChanged ||
    (patch.status !== undefined && patch.status !== item.status)
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
   * `actor` es el usuario del token: decide el tope del descuento (DX-204) y,
   * si atiende, es por defecto quien realizó el ítem (DX-050). `audit` es el
   * contexto de la petición para el evento de una corrección de la atribución
   * o de una salida de DONE, que el repositorio escribe en su transacción.
   */
  async execute(
    itemId: string,
    patch: UpdateTreatmentPlanItemInput,
    actor: DiscountActor,
    audit?: AuditRequestContext,
  ): Promise<TreatmentPlanItem> {
    const existing = await this.repo.findItemById(itemId);
    if (!existing) {
      throw new NotFoundException('Treatment plan item not found');
    }
    // Lo que no puede leerse dentro de la transacción: la política (solo si el
    // precio o el descuento pueden cambiar) y el `kind` del catálogo para el
    // espejo DONE (el ítem de catálogo no cambia).
    const policy =
      patch.price !== undefined ||
      patch.discount !== undefined ||
      patch.discountReason !== undefined ||
      patch.discountReasonNote !== undefined
        ? await this.discountPolicy.execute()
        : null;
    const kind =
      patch.status === TreatmentPlanItemStatus.DONE
        ? await this.catalogKind(existing.catalogItemId)
        : undefined;
    // DX-105: ¿la prestación admite descuentos? Solo importa si el precio o el
    // descuento pueden cambiar (el ítem de catálogo del ítem no cambia).
    const allowDiscount =
      patch.price !== undefined || patch.discount !== undefined
        ? await this.allowsDiscount(existing.catalogItemId)
        : true;
    const at = this.now();

    // BE-036: el estado del plan y del ítem se comprueban con sus filas
    // bloqueadas, dentro de la transacción: una aceptación que entre entre
    // medias no deja cambiar un plan ya aceptado.
    return this.repo.updateItem(
      itemId,
      ({ plan, item }) => {
        // SEC-050: el ítem de un cargo vigente (leído con su fila bloqueada) no
        // cambia de precio, descuento ni estado, sea cual sea el rol: se anula
        // desde la cita. El trigger `treatment_plan_items_cancellation_fee_locked`
        // es la red.
        if (item.cancellationFeeAppointmentId && touchesFeeItem(item, patch)) {
          throw new ConflictException(FEE_ITEM_LOCKED_MESSAGE);
        }
        // Plan cerrado (DX-109): nada, salvo marcar como realizado lo que quedó
        // aceptado en un plan completado, o corregir quién, cuándo o dónde se
        // realizó un ítem ya realizado (DX-050, DX-305).
        if (
          !isClosedPlanItemChangeAllowed(plan.status, item.status, patch) &&
          !isAttributionCorrection(plan.status, item.status, patch)
        ) {
          assertPlanOpenForItems(plan);
        }
        // DX-054: lo realizado no cambia de precio (ni al salir de DONE en la
        // misma petición), con el ítem leído bloqueado.
        if (isDoneItemPriceChange(item.status, item.price, patch.price)) {
          throw new ConflictException(DONE_ITEM_PRICE_LOCKED_MESSAGE);
        }
        // DX-050: con el ítem bloqueado, quién lo realizó, cuándo, y quién
        // puede cambiarlo (400/403 antes de escribir nada).
        const decided = decideAttribution(item, patch, actor, at);
        // DX-439: la cita solo acompaña a un paso a DONE; el repositorio
        // comprueba (con la cita bloqueada) que esté atendida y lleve el ítem.
        if (patch.appointmentId !== undefined && decided?.kind !== 'SET') {
          throw new BadRequestException(
            APPOINTMENT_ONLY_WHEN_MARKING_DONE_MESSAGE,
          );
        }
        const attribution =
          decided?.kind === 'SET' && patch.appointmentId !== undefined
            ? { ...decided, appointmentId: patch.appointmentId }
            : decided;
        // Plan aceptado con firma (DX-012): lo firmado (precio, descuento,
        // caras, notas) no cambia y el ítem no vuelve a propuesto; avanzar el
        // tratamiento (aceptado <-> realizado) sí.
        if (
          plan.acceptance &&
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
        const price = patch.price ?? item.price;
        const discount = patch.discount ?? item.discount;
        if (patch.price !== undefined || patch.discount !== undefined) {
          assertDiscountWithinPrice(price, discount);
        }

        const {
          discountReason,
          discountReasonNote,
          performedById: _performedById,
          completedAt: _completedAt,
          performedLocationId: _performedLocationId,
          appointmentId: _appointmentId,
          ...rest
        } = patch;
        const repoPatch: UpdateTreatmentPlanItemRepoInput = rest;
        const before = {
          catalogPrice: item.catalogPrice,
          price: item.price,
          discount: item.discount,
        };
        const after = { ...before, price, discount };
        // DX-105: sin descuentos, no se da uno nuevo ni se sube el que hubiera
        // (bajar o quitar uno anterior a la marca sí se puede).
        if (effectiveDiscountRises(before, after)) {
          assertDiscountAllowed(allowDiscount, after);
        }
        const changes = discountFieldChanges(item, patch);
        if (policy && touchesDiscount(before, after, changes)) {
          assertPlanDiscountable(plan);
          // Sin motivo en la petición se conserva el del ítem; cambiar de motivo
          // sin nota borra la nota anterior (era de otro motivo).
          const reason =
            discountReason !== undefined ? discountReason : item.discountReason;
          const note =
            discountReasonNote !== undefined
              ? discountReasonNote
              : discountReason !== undefined
                ? null
                : item.discountReasonNote;
          const decision = decideDiscountChange(
            policy,
            actor,
            before,
            { ...after, reason, reasonNote: note },
            changes,
            at,
          );
          if (decision) Object.assign(repoPatch, decision);
        }

        // Pieza B: a (PROPOSED|ACCEPTED) -> DONE transition mirrors the
        // procedure into the odontogram — same tooth/surfaces/catalog item,
        // status COMPLETED, linked back via `sourcePlanItemId`. DX-042
        // (DB-013): the repository does the transition AND the insert in ONE
        // transaction with the item locked, so two concurrent DONE never mirror
        // twice and a failed mirror never leaves the item DONE without its
        // clinical record. Tooth records are append-only: reverting a DONE item
        // does not remove the record (a done procedure is history).
        // DX-050: el registro lo firma quien realizó el procedimiento, no quien
        // lo marca.
        const mirror =
          kind !== undefined && attribution?.kind === 'SET'
            ? {
                patientId: plan.patientId,
                kind,
                performedById: attribution.performedById,
              }
            : undefined;
        return { patch: repoPatch, mirror, attribution };
      },
      audit,
    );
  }

  /** DX-105: `allowDiscount` del procedimiento (false si no se encuentra: cierra por defecto, como el descuento en bloque). */
  private async allowsDiscount(catalogItemId: string): Promise<boolean> {
    const catalogItem = await this.catalog.findById(catalogItemId);
    return catalogItem?.allowDiscount ?? false;
  }

  /**
   * ToothRecord requires `kind`; the item doesn't store it — take it from the
   * catalog item, defaulting to PROCEDURE (plan items are procedures).
   */
  private async catalogKind(catalogItemId: string): Promise<CatalogKind> {
    const catalogItem = await this.catalog.findById(catalogItemId);
    return catalogItem?.kind ?? CatalogKind.PROCEDURE;
  }
}
