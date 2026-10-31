import type { TreatmentPlanStatus } from '@prisma/client';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { allocationVersion } from '../../domain/allocation-rules';
import {
  ALLOCATION_MIGRATED_BALANCE,
  ALLOCATION_PAYMENT_NOT_FOUND,
} from '../../domain/allocation-messages';
import {
  PLAN_ALLOCATION_REPOSITORY,
  type PaymentAllocationsSnapshot,
  type PlanAllocationRepository,
} from '../../domain/ports/plan-allocation-repository.port';
import { fromCents } from '../../../../shared/money/money';

/** La imputación de un abono (spec §5.2 `PaymentAllocationsDto`). */
export interface PaymentAllocationsView {
  paymentId: string;
  receiptNumber: string | null;
  treatmentPlanId: string;
  paymentAmount: number;
  paymentCurrency: string;
  paidOn: string;
  planCurrency: string;
  /**
   * Un plan rechazado o cancelado no admite reasignar (409 en el PUT) y no
   * tiene ítems imputables: con esto la web lo explica sin intentarlo.
   */
  planStatus: TreatmentPlanStatus;
  planAmount: number | null;
  manual: boolean;
  allocated: number;
  unallocated: number | null;
  version: string;
  allocations: {
    treatmentPlanItemId: string;
    amount: number;
    source: 'AUTO' | 'MANUAL';
  }[];
  items: {
    itemId: string;
    toothNumber: string;
    procedureName: string;
    status: 'ACCEPTED' | 'DONE';
    billable: number;
    paidByOthers: number;
    free: number;
  }[];
}

/**
 * GET /payments/:id/allocations (DX-051): a qué ítems va el abono, lo que
 * admite cada ítem imputable sin contar este abono y la versión que el PUT
 * debe reenviar (R11). ADMIN y recepción.
 */
@Injectable()
export class GetPaymentAllocationsUseCase {
  constructor(
    @Inject(PLAN_ALLOCATION_REPOSITORY)
    private readonly repo: PlanAllocationRepository,
  ) {}

  async execute(paymentId: string): Promise<PaymentAllocationsView> {
    const snapshot = await this.repo.readPaymentAllocations(paymentId);
    if (!snapshot) throw new NotFoundException(ALLOCATION_PAYMENT_NOT_FOUND);
    return toView(snapshot);
  }
}

function toView(snapshot: PaymentAllocationsSnapshot): PaymentAllocationsView {
  const { target, lines, items } = snapshot;
  if (!target.treatmentPlanId || !target.planCurrency || !target.planStatus) {
    throw new ConflictException(ALLOCATION_MIGRATED_BALANCE);
  }
  const manual = target.base?.manual ?? false;
  const baseCents =
    target.base === null ? null : Math.round(target.base.amount * 100);
  const allocatedCents = lines.reduce((sum, l) => sum + l.cents, 0);
  // Las líneas en el orden de los ítems del plan; una línea en un ítem que
  // ya no es imputable (liberación en curso) va al final.
  const position = new Map(items.map((item, index) => [item.id, index]));
  const ordered = [...lines].sort(
    (a, b) =>
      (position.get(a.itemId) ?? items.length) -
        (position.get(b.itemId) ?? items.length) ||
      (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0),
  );
  return {
    paymentId: target.paymentId,
    receiptNumber: target.receiptNumber,
    treatmentPlanId: target.treatmentPlanId,
    paymentAmount: target.amount,
    paymentCurrency: target.currency,
    paidOn: target.paidOn,
    planCurrency: target.planCurrency,
    planStatus: target.planStatus,
    planAmount: baseCents === null ? null : fromCents(baseCents),
    manual,
    allocated: fromCents(allocatedCents),
    unallocated:
      baseCents === null ? null : fromCents(baseCents - allocatedCents),
    version: allocationVersion({ manual, lines }),
    allocations: ordered.map((l) => ({
      treatmentPlanItemId: l.itemId,
      amount: fromCents(l.cents),
      source: l.source,
    })),
    items: items.map((item) => ({
      itemId: item.id,
      toothNumber: item.toothNumber,
      procedureName: item.procedureName,
      status: item.status,
      billable: fromCents(item.billableCents),
      paidByOthers: fromCents(item.paidByOthersCents),
      free: fromCents(Math.max(0, item.billableCents - item.paidByOthersCents)),
    })),
  };
}
