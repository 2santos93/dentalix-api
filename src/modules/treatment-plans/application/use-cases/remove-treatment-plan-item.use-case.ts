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

@Injectable()
export class RemoveTreatmentPlanItemUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
  ) {}

  /** `audit`: para el evento del recall que mueva un DONE borrado (DX-015-bis). */
  async execute(itemId: string, audit?: AuditRequestContext): Promise<void> {
    const existing = await this.repo.findItemById(itemId);
    if (!existing) {
      throw new NotFoundException('Treatment plan item not found');
    }
    // SEC-050: quitar el ítem de un cargo vigente sería condonarlo sin permiso
    // ni motivo; se anula desde la cita. El trigger
    // `treatment_plan_items_cancellation_fee_locked` es la red.
    if (existing.cancellationFeeAppointmentId) {
      throw new ConflictException(FEE_ITEM_LOCKED_MESSAGE);
    }
    const plan = await this.repo.findPlanById(existing.planId);
    if (plan) assertItemsEditable(plan);

    // Soft-delete only — never a hard delete on a domain table.
    await this.repo.softDeleteItem(itemId, audit);
  }
}
