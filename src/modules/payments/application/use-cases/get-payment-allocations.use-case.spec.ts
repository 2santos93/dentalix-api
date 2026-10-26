import { ConflictException, NotFoundException } from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import { allocationVersion } from '../../domain/allocation-rules';
import {
  ALLOCATION_MIGRATED_BALANCE,
  ALLOCATION_PAYMENT_NOT_FOUND,
} from '../../domain/allocation-messages';
import type {
  AllocationTarget,
  PaymentAllocationsSnapshot,
  PlanAllocationRepository,
} from '../../domain/ports/plan-allocation-repository.port';
import { GetPaymentAllocationsUseCase } from './get-payment-allocations.use-case';

function target(over: Partial<AllocationTarget> = {}): AllocationTarget {
  return {
    paymentId: 'pay-1',
    receiptNumber: 'NOR-000123',
    treatmentPlanId: 'plan-1',
    amount: 100,
    currency: 'USD',
    paidOn: '2026-10-20',
    planCurrency: 'EUR',
    planStatus: TreatmentPlanStatus.ACCEPTED,
    base: { amount: 90, manual: false },
    ...over,
  };
}

function makeUseCase(snapshot: PaymentAllocationsSnapshot | null) {
  const repo = {
    readPaymentAllocations: jest.fn().mockResolvedValue(snapshot),
  };
  const uc = new GetPaymentAllocationsUseCase(
    repo as unknown as PlanAllocationRepository,
  );
  return { repo, uc };
}

describe('GetPaymentAllocationsUseCase (DX-051, spec §5.2)', () => {
  it('404 for a voided, missing or foreign payment', async () => {
    const { uc } = makeUseCase(null);
    const error = await uc.execute('pay-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as Error).message).toBe(ALLOCATION_PAYMENT_NOT_FOUND);
  });

  it('409 opening balance', async () => {
    const { uc } = makeUseCase({
      target: target({
        treatmentPlanId: null,
        planCurrency: null,
        planStatus: null,
        base: null,
      }),
      lines: [],
      items: [],
    });
    const error = await uc.execute('pay-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toBe(ALLOCATION_MIGRATED_BALANCE);
  });

  it('returns receiptNumber, lines, items with what is free and the version', async () => {
    const { uc } = makeUseCase({
      target: target(),
      lines: [
        { itemId: 'item-b', cents: 2000, source: 'AUTO' },
        { itemId: 'item-a', cents: 5050, source: 'AUTO' },
      ],
      items: [
        {
          id: 'item-a',
          toothNumber: '11',
          procedureName: 'Resina',
          status: 'DONE',
          billableCents: 10000,
          paidByOthersCents: 3000,
        },
        {
          id: 'item-b',
          toothNumber: '12',
          procedureName: 'Corona',
          status: 'ACCEPTED',
          billableCents: 4000,
          paidByOthersCents: 5000,
        },
      ],
    });

    const view = await uc.execute('pay-1');

    expect(view).toEqual({
      paymentId: 'pay-1',
      receiptNumber: 'NOR-000123',
      treatmentPlanId: 'plan-1',
      paymentAmount: 100,
      paymentCurrency: 'USD',
      paidOn: '2026-10-20',
      planCurrency: 'EUR',
      planStatus: TreatmentPlanStatus.ACCEPTED,
      planAmount: 90,
      manual: false,
      allocated: 70.5,
      unallocated: 19.5,
      version: allocationVersion({
        manual: false,
        lines: [
          { itemId: 'item-a', cents: 5050 },
          { itemId: 'item-b', cents: 2000 },
        ],
      }),
      // En el orden de los ítems del plan.
      allocations: [
        { treatmentPlanItemId: 'item-a', amount: 50.5, source: 'AUTO' },
        { treatmentPlanItemId: 'item-b', amount: 20, source: 'AUTO' },
      ],
      items: [
        {
          itemId: 'item-a',
          toothNumber: '11',
          procedureName: 'Resina',
          status: 'DONE',
          billable: 100,
          paidByOthers: 30,
          free: 70,
        },
        {
          itemId: 'item-b',
          toothNumber: '12',
          procedureName: 'Corona',
          status: 'ACCEPTED',
          billable: 40,
          paidByOthers: 50,
          free: 0,
        },
      ],
    });
  });

  it('a payment without base has no planAmount nor unallocated', async () => {
    const { uc } = makeUseCase({
      target: target({ base: null }),
      lines: [],
      items: [],
    });

    const view = await uc.execute('pay-1');

    expect(view).toMatchObject({
      planAmount: null,
      manual: false,
      allocated: 0,
      unallocated: null,
      version: allocationVersion({ manual: false, lines: [] }),
    });
  });

  it('a pinned payment says so and its version includes it', async () => {
    const { uc } = makeUseCase({
      target: target({ base: { amount: 90, manual: true } }),
      lines: [],
      items: [],
    });

    const view = await uc.execute('pay-1');

    expect(view.manual).toBe(true);
    expect(view.version).toBe(allocationVersion({ manual: true, lines: [] }));
  });

  it('a cancelled plan reads with its status and no allocatable items', async () => {
    const { uc } = makeUseCase({
      target: target({ planStatus: TreatmentPlanStatus.CANCELLED }),
      lines: [],
      items: [],
    });

    const view = await uc.execute('pay-1');

    expect(view).toMatchObject({
      planStatus: TreatmentPlanStatus.CANCELLED,
      items: [],
    });
  });
});
