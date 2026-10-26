import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import type { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';
import {
  ALLOCATION_MIGRATED_BALANCE,
  ALLOCATION_PAYMENT_NOT_FOUND,
} from '../../domain/allocation-messages';
import type {
  AllocationTarget,
  PaymentAllocationsSnapshot,
  PlanAllocationRepository,
} from '../../domain/ports/plan-allocation-repository.port';
import type { PlanAllocationRebalancer } from '../plan-allocation-rebalancer';
import { GetPaymentAllocationsUseCase } from './get-payment-allocations.use-case';
import { ReplacePaymentAllocationsUseCase } from './replace-payment-allocations.use-case';

const VERSION = 'a'.repeat(64);

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

function makeUseCase(
  targets: (AllocationTarget | null)[],
  opts: { rate?: number; rebalanceFails?: boolean; voidedAfter?: boolean } = {},
) {
  const calls: string[] = [];
  const snapshot: PaymentAllocationsSnapshot = {
    target: target({ base: { amount: 90, manual: true } }),
    lines: [{ itemId: 'item-a', cents: 4000, source: 'MANUAL' }],
    items: [],
  };
  const findAllocationTarget = jest.fn();
  for (const t of targets) findAllocationTarget.mockResolvedValueOnce(t);
  const repo = {
    findAllocationTarget,
    ensureBase: jest.fn().mockImplementation(() => {
      calls.push('ensureBase');
      return Promise.resolve(true);
    }),
    replaceAllocations: jest.fn().mockImplementation(() => {
      calls.push('replace');
      return Promise.resolve({
        previous: [{ itemId: 'item-b', cents: 9000 }],
      });
    }),
    readPaymentAllocations: jest.fn().mockImplementation(() => {
      calls.push('read');
      return Promise.resolve(opts.voidedAfter ? null : snapshot);
    }),
  };
  const rebalancer = {
    rebalancePlan: jest.fn().mockImplementation(() => {
      calls.push('rebalance');
      return opts.rebalanceFails
        ? Promise.reject(new Error('reparto roto'))
        : Promise.resolve({ allocatedCents: 0 });
    }),
  };
  const convert = {
    execute: jest
      .fn()
      .mockImplementation(() =>
        opts.rate === undefined
          ? Promise.reject(new BadRequestException('unsupported currency: USD'))
          : Promise.resolve({ rateUsed: opts.rate }),
      ),
  };
  const allocations = repo as unknown as PlanAllocationRepository;
  const uc = new ReplacePaymentAllocationsUseCase(
    allocations,
    rebalancer as unknown as PlanAllocationRebalancer,
    convert as unknown as ConvertAmountUseCase,
    new GetPaymentAllocationsUseCase(allocations),
  );
  return { repo, rebalancer, convert, uc, calls };
}

const manual = (lines: { treatmentPlanItemId: string; amount: number }[]) => ({
  expectedVersion: VERSION,
  mode: 'MANUAL' as const,
  allocations: lines,
});

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: Error) => e,
  );
}

describe('ReplacePaymentAllocationsUseCase (DX-051, spec R10)', () => {
  it('404 for a voided payment', async () => {
    const { uc, repo } = makeUseCase([null]);
    const error = await errorOf(uc.execute('pay-1', manual([]), 'admin-1'));
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.message).toBe(ALLOCATION_PAYMENT_NOT_FOUND);
    expect(repo.replaceAllocations).not.toHaveBeenCalled();
  });

  it('409 opening balance', async () => {
    const { uc, repo } = makeUseCase([
      target({
        treatmentPlanId: null,
        planCurrency: null,
        planStatus: null,
        base: null,
      }),
    ]);
    const error = await errorOf(uc.execute('pay-1', manual([]), 'admin-1'));
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe(ALLOCATION_MIGRATED_BALANCE);
    expect(repo.replaceAllocations).not.toHaveBeenCalled();
  });

  it('409 cancelled plan', async () => {
    const { uc, repo } = makeUseCase([
      target({ planStatus: TreatmentPlanStatus.CANCELLED }),
    ]);
    const error = await errorOf(uc.execute('pay-1', manual([]), 'admin-1'));
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe(
      'El plan está «Cancelado»: sus abonos no se imputan a ítems.',
    );
    expect(repo.replaceAllocations).not.toHaveBeenCalled();
  });

  it('409 no rate after trying to create the base', async () => {
    const { uc, repo, convert } = makeUseCase([target({ base: null })]);
    const error = await errorOf(uc.execute('pay-1', manual([]), 'admin-1'));
    expect(convert.execute).toHaveBeenCalledWith({
      amount: 100,
      from: 'USD',
      to: 'EUR',
      date: '2026-10-20',
    });
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toBe(
      'No hay tasa de cambio de USD a EUR para el 2026-10-20: este abono no se puede imputar todavía.',
    );
    expect(repo.ensureBase).not.toHaveBeenCalled();
    expect(repo.replaceAllocations).not.toHaveBeenCalled();
  });

  it('409 no rate when the base still does not exist after ensureBase', async () => {
    const { uc, repo } = makeUseCase(
      [target({ base: null }), target({ base: null })],
      { rate: 0.9 },
    );
    const error = await errorOf(uc.execute('pay-1', manual([]), 'admin-1'));
    expect(error).toBeInstanceOf(ConflictException);
    expect(repo.replaceAllocations).not.toHaveBeenCalled();
  });

  it('404 when the payment is voided while its base is being created', async () => {
    const { uc, repo } = makeUseCase([target({ base: null }), null], {
      rate: 0.9,
    });
    const error = await errorOf(uc.execute('pay-1', manual([]), 'admin-1'));
    expect(error).toBeInstanceOf(NotFoundException);
    expect(repo.replaceAllocations).not.toHaveBeenCalled();
  });

  it('creates the base on first PUT of a legacy payment', async () => {
    const { uc, repo, calls } = makeUseCase(
      [target({ base: null }), target()],
      { rate: 0.9 },
    );

    await uc.execute(
      'pay-1',
      manual([{ treatmentPlanItemId: 'item-a', amount: 40 }]),
      'admin-1',
    );

    expect(repo.ensureBase).toHaveBeenCalledWith(
      'pay-1',
      90,
      'EUR',
      '2026-10-20',
    );
    expect(calls.slice(0, 2)).toEqual(['ensureBase', 'replace']);
  });

  it('passes the lines in cents, rebalances and reads the response afterwards', async () => {
    const { uc, repo, rebalancer, calls } = makeUseCase([target()]);

    await uc.execute(
      'pay-1',
      manual([
        { treatmentPlanItemId: 'item-a', amount: 10.1 },
        { treatmentPlanItemId: 'item-b', amount: 0.29 },
      ]),
      'admin-1',
    );

    expect(repo.ensureBase).not.toHaveBeenCalled();
    expect(repo.replaceAllocations).toHaveBeenCalledWith({
      paymentId: 'pay-1',
      mode: 'MANUAL',
      expectedVersion: VERSION,
      lines: [
        { itemId: 'item-a', cents: 1010 },
        { itemId: 'item-b', cents: 29 },
      ],
      actorId: 'admin-1',
    });
    expect(rebalancer.rebalancePlan).toHaveBeenCalledWith('plan-1', 'admin-1');
    expect(calls).toEqual(['replace', 'rebalance', 'read']);
  });

  it('AUTO sends no lines', async () => {
    const { uc, repo } = makeUseCase([target()]);

    await uc.execute(
      'pay-1',
      { expectedVersion: VERSION, mode: 'AUTO' },
      'admin-1',
    );

    expect(repo.replaceAllocations).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'AUTO', lines: [] }),
    );
  });

  it('returns receiptNumber and the previous lines', async () => {
    const { uc } = makeUseCase([target()]);

    const result = await uc.execute('pay-1', manual([]), 'admin-1');

    expect(result.receiptNumber).toBe('NOR-000123');
    expect(result.manual).toBe(true);
    expect(result.allocations).toEqual([
      { treatmentPlanItemId: 'item-a', amount: 40, source: 'MANUAL' },
    ]);
    expect(result.previous).toEqual([
      { treatmentPlanItemId: 'item-b', amount: 90 },
    ]);
  });

  it('a failing rebalance does not fail the reallocation (the plan stays queued)', async () => {
    const { uc, calls } = makeUseCase([target()], { rebalanceFails: true });

    const result = await uc.execute('pay-1', manual([]), 'admin-1');

    expect(result.previous).toHaveLength(1);
    expect(calls).toEqual(['replace', 'rebalance', 'read']);
  });

  it('a payment voided after the commit still answers the committed reallocation (so it is audited)', async () => {
    const { uc, calls } = makeUseCase([target()], { voidedAfter: true });

    const result = await uc.execute(
      'pay-1',
      manual([{ treatmentPlanItemId: 'item-a', amount: 40 }]),
      'admin-1',
    );

    expect(calls).toEqual(['replace', 'rebalance', 'read']);
    expect(result).toMatchObject({
      paymentId: 'pay-1',
      receiptNumber: 'NOR-000123',
      planCurrency: 'EUR',
      planStatus: TreatmentPlanStatus.ACCEPTED,
      planAmount: 90,
      manual: true,
      allocated: 0,
      unallocated: 90,
      allocations: [],
      items: [],
      previous: [{ treatmentPlanItemId: 'item-b', amount: 90 }],
    });
  });

  it('other errors of the re-read still fail', async () => {
    const { uc, repo } = makeUseCase([target()]);
    repo.readPaymentAllocations.mockRejectedValueOnce(new Error('BD caída'));

    const error = await errorOf(uc.execute('pay-1', manual([]), 'admin-1'));

    expect(error.message).toBe('BD caída');
  });
});
