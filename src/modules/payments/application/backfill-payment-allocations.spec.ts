import { BadRequestException } from '@nestjs/common';
import type { ConvertAmountUseCase } from '../../exchange/application/use-cases/convert-amount.use-case';
import type { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { backfillPaymentAllocations } from './backfill-payment-allocations';
import { PlanAllocationRebalancer } from './plan-allocation-rebalancer';
import { InMemoryPlanAllocationRepository } from './__fixtures__/in-memory-plan-allocation.repository';

const DAY = (d: number) => new Date(Date.UTC(2026, 9, d, 12));

function fakeConvert(rates: Record<string, number>) {
  return {
    execute: (input: { amount: number; from: string; to: string }) => {
      const rate = input.from === input.to ? 1 : rates[input.from];
      if (rate === undefined) {
        return Promise.reject(
          new BadRequestException(`unsupported currency: ${input.from}`),
        );
      }
      return Promise.resolve({ ...input, rateUsed: rate });
    },
  } as unknown as ConvertAmountUseCase;
}

const tenantContext = {
  run: (_tenantId: string, fn: () => unknown) => fn(),
} as unknown as TenantContextService;

function setup(rates: Record<string, number> = {}) {
  const repo = new InMemoryPlanAllocationRepository();
  repo.tenants = ['t1', 't2'];
  const convertAmount = fakeConvert(rates);
  const rebalancer = new PlanAllocationRebalancer(repo, convertAmount);
  return {
    repo,
    deps: { repo, rebalancer, convertAmount, tenantContext },
  };
}

describe('backfillPaymentAllocations', () => {
  it('rejects a tenant that is not live', async () => {
    const { deps } = setup();
    await expect(
      backfillPaymentAllocations(deps, { tenantId: 'other' }),
    ).rejects.toThrow('no existe');
  });

  it('runs only the requested tenant', async () => {
    const { deps } = setup();
    const reports = await backfillPaymentAllocations(deps, { tenantId: 't2' });
    expect(reports.map((r) => r.tenantId)).toEqual(['t2']);
  });

  it('counts payments without a rate instead of failing', async () => {
    const { repo, deps } = setup();
    repo.withoutBase = [
      {
        paymentId: 'p1',
        amount: 10,
        currency: 'XXX',
        planCurrency: 'EUR',
        paidOn: '2026-10-01',
        exchangeRateCurrency: null,
        frozenRate: null,
      },
    ];
    const [report] = await backfillPaymentAllocations(deps, {
      tenantId: 't1',
    });
    expect(report).toMatchObject({ basesCreated: 0, withoutRate: 1 });
    expect(repo.bases.size).toBe(0);
  });

  it('dry-run counts bases without inserting them', async () => {
    const { repo, deps } = setup({ USD: 0.9 });
    repo.withoutBase = [
      {
        paymentId: 'p1',
        amount: 10,
        currency: 'USD',
        planCurrency: 'EUR',
        paidOn: '2026-10-01',
        exchangeRateCurrency: null,
        frozenRate: null,
      },
    ];
    const [report] = await backfillPaymentAllocations(deps, {
      tenantId: 't1',
      dryRun: true,
    });
    expect(report.basesCreated).toBe(1);
    expect(repo.bases.size).toBe(0);
  });

  it('reports what the automatic rule allocates and writes nothing on dry-run', async () => {
    const { repo, deps } = setup();
    repo.items.push({
      id: 'i1',
      planId: 'plan-1',
      status: 'DONE',
      createdAt: DAY(1),
      completedAt: DAY(2),
      billableCents: 10_000,
    });
    repo.payments.push({
      id: 'p1',
      planId: 'plan-1',
      paidAt: DAY(3),
      createdAt: DAY(3),
      baseCents: 6_000,
    });
    const [dry] = await backfillPaymentAllocations(deps, {
      tenantId: 't1',
      dryRun: true,
    });
    expect(dry).toMatchObject({ plansRebalanced: 1, allocatedCents: 6_000 });
    expect(repo.allocations).toHaveLength(0);

    const [real] = await backfillPaymentAllocations(deps, { tenantId: 't1' });
    expect(real.allocatedCents).toBe(6_000);
    const [again] = await backfillPaymentAllocations(deps, { tenantId: 't1' });
    expect(again).toMatchObject({
      basesCreated: 0,
      plansRebalanced: 0,
      allocatedCents: 0,
    });
  });

  it('removes allocations left on voided payments and re-spreads what they held', async () => {
    const { repo, deps } = setup();
    repo.items.push({
      id: 'i1',
      planId: 'plan-1',
      status: 'DONE',
      createdAt: DAY(1),
      completedAt: DAY(2),
      billableCents: 10_000,
    });
    repo.payments.push(
      {
        id: 'voided',
        planId: 'plan-1',
        paidAt: DAY(3),
        createdAt: DAY(3),
        baseCents: 10_000,
        voided: true,
      },
      {
        id: 'live',
        planId: 'plan-1',
        paidAt: DAY(4),
        createdAt: DAY(4),
        baseCents: 6_000,
      },
    );
    repo.allocations.push({
      paymentId: 'voided',
      itemId: 'i1',
      cents: 10_000,
      source: 'AUTO',
      createdById: null,
    });

    const dry = await backfillPaymentAllocations(deps, {
      tenantId: 't1',
      dryRun: true,
    });
    expect(dry[0].voidedCleaned).toBe(0);
    expect(repo.allocations).toHaveLength(1);

    const [report] = await backfillPaymentAllocations(deps, { tenantId: 't1' });
    expect(report).toMatchObject({
      voidedCleaned: 1,
      plansRebalanced: 1,
      allocatedCents: 6_000,
    });
    expect(repo.allocations.map((a) => [a.paymentId, a.cents])).toEqual([
      ['live', 6_000],
    ]);
  });
});
