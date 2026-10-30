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

    it('drains first the plan of the route payment (void)', async () => {
      const { repo, rebalancer } = setup();
      for (const id of ['a', 'b']) seedPlan(repo, id);
      repo.payments.push({
        id: 'voided',
        planId: 'b',
        paidAt: DAY(3),
        createdAt: DAY(3),
        baseCents: 1_000,
      });
      repo.requests.push('a', 'b');
      const spy = jest.spyOn(repo, 'rebalance');

      await rebalancer.drainPending({
        actorId: null,
        preferPaymentId: 'voided',
        limit: 1,
      });

      expect(spy.mock.calls.map(([planId]) => planId)).toEqual(['b']);
    });

    it('drains without preference when the plan of the payment cannot be read', async () => {
      const { repo, rebalancer } = setup();
      for (const id of ['a', 'b']) seedPlan(repo, id);
      repo.requests.push('a', 'b');
      jest.spyOn(repo, 'planOfPayment').mockRejectedValue(new Error('caída'));
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      await expect(
        rebalancer.drainPending({ actorId: null, preferPaymentId: 'voided' }),
      ).resolves.toBe(2);

      expect(repo.requests).toEqual([]);
      expect(warn).toHaveBeenCalledWith({
        event: 'payments.allocation_drain_preference_failed',
        error: 'Error',
      });
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

  // DX-375: el barrido congela la tasa de los abonos que la esperan, con la
  // fuente de la clínica y el día civil de cada uno; la base sale de ella.
  describe('freezeAllPending (DX-375, BE-047)', () => {
    function quoting(rates: Record<string, number>, source = 'AUTOMATIC') {
      const convert = {
        memoized: () => convert,
        execute: () => Promise.reject(new Error('no debe convertir en vivo')),
        quote: (input: { from: string; to: string; date: string }) => {
          const perBase = (c: string) => (c === 'USD' ? 1 : rates[c]);
          if (
            perBase(input.from) === undefined ||
            perBase(input.to) === undefined
          ) {
            return Promise.reject(
              new BadRequestException(`unsupported currency: ${input.from}`),
            );
          }
          return Promise.resolve({
            ...input,
            source,
            fromPerBase: perBase(input.from),
            toPerBase: perBase(input.to),
          });
        },
      };
      return convert as unknown as ConvertAmountUseCase;
    }

    it('congela la tasa de su día y cuenta los que siguen sin tasa', async () => {
      const repo = new InMemoryPlanAllocationRepository();
      const rebalancer = new PlanAllocationRebalancer(
        repo,
        quoting({ COP: 4000 }),
      );
      repo.pendingRate = [
        {
          paymentId: 'cop',
          currency: 'COP',
          targetCurrency: 'USD',
          paidOn: '2026-10-20',
        },
        {
          paymentId: 'ves',
          currency: 'VES',
          targetCurrency: 'USD',
          paidOn: '2026-10-20',
        },
      ];
      await expect(rebalancer.freezeAllPending(50)).resolves.toEqual({
        frozen: 1,
        withoutRate: 1,
      });
      expect(repo.frozen.get('cop')).toEqual({
        targetCurrency: 'USD',
        rate: {
          currency: 'USD',
          fromPerBase: 4000,
          toPerBase: 1,
          source: 'AUTOMATIC',
          date: '2026-10-20',
        },
      });
      // Sin tasa también queda con su moneda de destino (deja de ser anterior).
      expect(repo.frozen.get('ves')).toEqual({
        targetCurrency: 'USD',
        rate: null,
      });
    });

    it('un abono anterior en su misma moneda solo recibe su moneda de destino', async () => {
      const repo = new InMemoryPlanAllocationRepository();
      const rebalancer = new PlanAllocationRebalancer(repo, quoting({}));
      repo.pendingRate = [
        {
          paymentId: 'usd',
          currency: 'USD',
          targetCurrency: 'USD',
          paidOn: '2026-10-20',
        },
      ];
      await expect(rebalancer.freezeAllPending(50)).resolves.toEqual({
        frozen: 0,
        withoutRate: 0,
      });
      expect(repo.frozen.get('usd')).toEqual({
        targetCurrency: 'USD',
        rate: null,
      });
    });

    it('freezeAllPending recorre por lotes hasta que no queda nada que congelar', async () => {
      const repo = new InMemoryPlanAllocationRepository();
      const rebalancer = new PlanAllocationRebalancer(
        repo,
        quoting({ COP: 4000 }),
      );
      repo.pendingRate = Array.from({ length: 5 }, (_, i) => ({
        paymentId: `cop-${i}`,
        currency: 'COP',
        targetCurrency: 'USD',
        paidOn: '2026-10-20',
      }));
      await expect(rebalancer.freezeAllPending(2)).resolves.toEqual({
        frozen: 5,
        withoutRate: 0,
      });
    });

    it('freezeAllPending termina aunque queden abonos sin tasa', async () => {
      const repo = new InMemoryPlanAllocationRepository();
      const rebalancer = new PlanAllocationRebalancer(repo, quoting({}));
      repo.pendingRate = [
        {
          paymentId: 'ves',
          currency: 'VES',
          targetCurrency: 'USD',
          paidOn: '2026-10-20',
        },
      ];
      await expect(rebalancer.freezeAllPending(2)).resolves.toEqual({
        frozen: 0,
        withoutRate: 1,
      });
    });
  });
});
