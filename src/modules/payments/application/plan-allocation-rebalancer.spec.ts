import { BadRequestException, Logger } from '@nestjs/common';
import type { ConvertAmountUseCase } from '../../exchange/application/use-cases/convert-amount.use-case';
import { PlanAllocationRebalancer } from './plan-allocation-rebalancer';
import { InMemoryPlanAllocationRepository } from './__fixtures__/in-memory-plan-allocation.repository';

const DAY = (d: number) => new Date(Date.UTC(2026, 9, d, 12));

/** Convierte con la tasa del mapa (moneda → tasa); sin entrada, «sin tasa». */
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

function setup(rates: Record<string, number> = {}) {
  const repo = new InMemoryPlanAllocationRepository();
  const rebalancer = new PlanAllocationRebalancer(repo, fakeConvert(rates));
  return { repo, rebalancer };
}

/** Plan con un ítem DONE de 100 y uno ACCEPTED de 50. */
function seedPlan(repo: InMemoryPlanAllocationRepository, planId = 'plan-1') {
  repo.items.push(
    {
      id: `${planId}-done`,
      planId,
      status: 'DONE',
      createdAt: DAY(1),
      completedAt: DAY(2),
      billableCents: 10_000,
    },
    {
      id: `${planId}-accepted`,
      planId,
      status: 'ACCEPTED',
      createdAt: DAY(1),
      completedAt: null,
      billableCents: 5_000,
    },
  );
}

describe('PlanAllocationRebalancer', () => {
  afterEach(() => jest.restoreAllMocks());

  it('allocates new payment after older surplus', async () => {
    const { repo, rebalancer } = setup();
    seedPlan(repo);
    repo.payments.push(
      // Llega después pero se cobró antes: es el donante más antiguo.
      {
        id: 'newer',
        planId: 'plan-1',
        paidAt: DAY(10),
        createdAt: DAY(10),
        baseCents: 8_000,
      },
      {
        id: 'older',
        planId: 'plan-1',
        paidAt: DAY(5),
        createdAt: DAY(11),
        baseCents: 12_000,
      },
    );

    const result = await rebalancer.rebalancePlan('plan-1', 'user-1');

    expect(result).toEqual({ allocatedCents: 15_000 });
    expect(repo.allocations).toEqual([
      expect.objectContaining({
        paymentId: 'older',
        itemId: 'plan-1-done',
        cents: 10_000,
        source: 'AUTO',
        createdById: 'user-1',
      }),
      expect.objectContaining({
        paymentId: 'older',
        itemId: 'plan-1-accepted',
        cents: 2_000,
      }),
      expect.objectContaining({
        paymentId: 'newer',
        itemId: 'plan-1-accepted',
        cents: 3_000,
      }),
    ]);
    // Idempotente: una segunda pasada no imputa nada más.
    expect(await rebalancer.rebalancePlan('plan-1', 'user-1')).toEqual({
      allocatedCents: 0,
    });
  });

  it('skips manual payments as donors', async () => {
    const { repo, rebalancer } = setup();
    seedPlan(repo);
    repo.payments.push(
      {
        id: 'pinned',
        planId: 'plan-1',
        paidAt: DAY(3),
        createdAt: DAY(3),
        baseCents: 9_000,
        manual: true,
      },
      {
        id: 'auto',
        planId: 'plan-1',
        paidAt: DAY(4),
        createdAt: DAY(4),
        baseCents: 2_000,
      },
    );

    await rebalancer.rebalancePlan('plan-1', null);

    expect(repo.allocatedCents({ paymentId: 'pinned' })).toBe(0);
    expect(repo.allocatedCents({ paymentId: 'auto' })).toBe(2_000);
    expect(repo.allocatedCents({ itemId: 'plan-1-done' })).toBe(2_000);
  });

  it('dryRun returns allocatedCents and writes nothing', async () => {
    const { repo, rebalancer } = setup();
    seedPlan(repo);
    repo.payments.push({
      id: 'p',
      planId: 'plan-1',
      paidAt: DAY(3),
      createdAt: DAY(3),
      baseCents: 12_000,
    });
    repo.requests.push('plan-1');

    const result = await rebalancer.rebalancePlan('plan-1', null, {
      dryRun: true,
    });

    expect(result).toEqual({ allocatedCents: 12_000 });
    expect(repo.allocations).toEqual([]);
    expect(repo.requests).toEqual(['plan-1']);
  });

  describe('drainPending', () => {
    it('drains the preferred plan first, at most `limit` plans', async () => {
      const { repo, rebalancer } = setup();
      for (const id of ['a', 'b', 'c']) seedPlan(repo, id);
      repo.requests.push('a', 'b', 'c', 'a');
      const spy = jest.spyOn(repo, 'rebalance');

      const drained = await rebalancer.drainPending({
        actorId: 'user-1',
        preferPlanId: 'c',
        limit: 2,
      });

      expect(drained).toBe(2);
      expect(spy.mock.calls.map(([planId]) => planId)).toEqual(['c', 'a']);
      expect(spy.mock.calls[0][1]).toEqual({
        actorId: 'user-1',
        onlyIfRequested: true,
      });
      expect(repo.requests).toEqual(['b']);
    });

    it('never throws: a failing plan is logged once and the rest drain', async () => {
      const { repo, rebalancer } = setup();
      for (const id of ['a', 'b']) seedPlan(repo, id);
      repo.requests.push('a', 'b');
      repo.failingPlans.add('a');
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      await expect(rebalancer.drainPending({ actorId: null })).resolves.toBe(1);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toEqual({
        event: 'payments.allocation_rebalance_failed',
        planId: 'a',
        error: 'Error',
      });
      expect(repo.requests).toEqual(['a']);
    });

    it('never throws when listing the queue fails', async () => {
      const { repo, rebalancer } = setup();
      jest.spyOn(repo, 'pendingPlanIds').mockRejectedValue(new Error('caída'));
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await expect(rebalancer.drainPending({ actorId: null })).resolves.toBe(0);
    });
  });

  describe('createMissingBases', () => {
    it('converts at paidOn, creates the base and counts payments without rate', async () => {
      const { repo, rebalancer } = setup({ USD: 0.9 });
      repo.withoutBase = [
        {
          paymentId: 'usd',
          amount: 100,
          currency: 'USD',
          planCurrency: 'EUR',
          paidOn: '2026-10-20',
        },
        {
          paymentId: 'gbp',
          amount: 50,
          currency: 'GBP',
          planCurrency: 'EUR',
          paidOn: '2026-10-20',
        },
      ];

      await expect(rebalancer.createMissingBases(50)).resolves.toEqual({
        created: 1,
        withoutRate: 1,
      });
      expect(repo.bases.get('usd')).toEqual({
        amount: 90,
        currency: 'EUR',
        rateDate: '2026-10-20',
      });
    });

    it('a conversion failure other than «no rate» counts as without rate and is logged', async () => {
      const repo = new InMemoryPlanAllocationRepository();
      const convert = {
        execute: () => Promise.reject(new Error('proveedor caído')),
      } as unknown as ConvertAmountUseCase;
      const rebalancer = new PlanAllocationRebalancer(repo, convert);
      repo.withoutBase = [
        {
          paymentId: 'usd',
          amount: 100,
          currency: 'USD',
          planCurrency: 'EUR',
          paidOn: '2026-10-20',
        },
      ];
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      await expect(rebalancer.createMissingBases(50)).resolves.toEqual({
        created: 0,
        withoutRate: 1,
      });
      expect(warn).toHaveBeenCalledWith({
        event: 'payments.allocation_base_conversion_failed',
        paymentId: 'usd',
        error: 'Error',
      });
    });
  });
});
