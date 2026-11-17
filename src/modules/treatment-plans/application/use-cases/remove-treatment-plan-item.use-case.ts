import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type { TreatmentPlanRepository } from '../../domain/ports/treatment-plan-repository.port';
import { assertItemsEditable } from './signed-plan-lock';
import { FEE_ITEM_LOCKED_MESSAGE } from '../../../cancellation-fees/domain/cancellation-fee';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { PLAN_ITEM_NOT_FOUND_MESSAGE } from '../../domain/treatment-plan-messages';

@Injectable()
export class RemoveTreatmentPlanItemUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
  ) {}

  /**
   * `audit`: para el evento del recall que mueva un DONE borrado (DX-015-bis).
   * `planId`: el `:id` de la ruta; un ítem de otro plan responde 404 (DX-111).
   */
  async execute(
    itemId: string,
    audit?: AuditRequestContext,
    planId?: string,
  ): Promise<void> {
    const existing = await this.repo.findItemById(itemId);
    if (!existing || (planId !== undefined && existing.planId !== planId)) {
      throw new NotFoundException(PLAN_ITEM_NOT_FOUND_MESSAGE);
    }
    // SEC-050: quitar el ítem de un cargo vigente sería condonarlo sin permiso
    // ni motivo; se anula desde la cita. El trigger
    // `treatment_plan_items_cancellation_fee_locked` es la red.
    if (existing.cancellationFeeAppointmentId) {
      throw new ConflictException(FEE_ITEM_LOCKED_MESSAGE);
    }
    const plan = await this.repo.findPlanById(existing.planId);
    if (plan) assertItemsEditable(plan);

    // Soft-delete only — never a hard delete on a domain table. DX-123: la
    // misma regla otra vez con el plan bloqueado, dentro de la transacción:
    // un plan que se cierra o se firma entre medias da su 409 específico, no
    // el genérico del trigger.
    await this.repo.softDeleteItem(itemId, audit, assertItemsEditable);
  }
}
