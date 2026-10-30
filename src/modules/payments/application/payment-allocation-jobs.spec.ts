import { Logger } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import { parseCron } from '../../jobs/domain/cron';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { PaymentAllocationJobs } from './payment-allocation-jobs';
import { ExchangeSourceChangeHooks } from '../../exchange/application/exchange-source-change-hooks';
import type { PlanAllocationRebalancer } from './plan-allocation-rebalancer';
import { InMemoryPlanAllocationRepository } from './__fixtures__/in-memory-plan-allocation.repository';

function setup() {
  const tenantContext = new TenantContextService();
  const repo = new InMemoryPlanAllocationRepository();
  const calls: string[] = [];
  const rebalancer = {
    freezeAllPending: jest.fn(() => {
      calls.push(`all-rates:${tenantContext.getTenantId()}`);
      return Promise.resolve({ frozen: 0, withoutRate: 0 });
    }),
    freezePendingRates: jest.fn((limit: number) => {
      calls.push(`rates:${tenantContext.getTenantId()}:${limit}`);
      return Promise.resolve({ frozen: 0, withoutRate: 0 });
    }),
    createMissingBases: jest.fn((limit: number) => {
      calls.push(`bases:${tenantContext.getTenantId()}:${limit}`);
      return Promise.resolve({ created: 0, withoutRate: 0 });
    }),
    drainPending: jest.fn(
      (opts: { actorId: string | null; limit?: number }) => {
        calls.push(
          `drain:${tenantContext.getTenantId()}:${opts.actorId}:${opts.limit}`,
        );
        return Promise.resolve(0);
      },
    ),
  };
  const registry = new JobRegistry();
  const hooks = new ExchangeSourceChangeHooks();
  const jobs = new PaymentAllocationJobs(
    registry,
    rebalancer as unknown as PlanAllocationRebalancer,
    repo,
    tenantContext,
    hooks,
  );
  return { registry, jobs, repo, rebalancer, calls, hooks, tenantContext };
}

describe('PaymentAllocationJobs (DX-051)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('registra el barrido y su tarea de cada minuto en la cola de DX-085', () => {
    const { registry, jobs } = setup();
    jobs.onModuleInit();

    expect(registry.names()).toEqual(['payment-allocations.sweep']);
    const [schedule] = registry.schedules();
    expect(schedule).toMatchObject({
      name: 'payment-allocations.sweep.every-minute',
      job: 'payment-allocations.sweep',
    });
    const first = parseCron(schedule.cron).next(
      new Date('2026-10-26T00:00:00Z'),
    );
    expect(
      parseCron(schedule.cron).next(first).getTime() - first.getTime(),
    ).toBe(60_000);
  });

  // BE-047 (DX-375): antes de cambiar la fuente de la tasa, la clínica del
  // contexto congela TODOS sus abonos pendientes.
  it('registra congelar los abonos pendientes de la clínica antes de un cambio de fuente', async () => {
    const { jobs, hooks, calls, tenantContext } = setup();
    jobs.onModuleInit();

    await tenantContext.run('t1', () => hooks.beforeSourceChange());

    expect(calls).toEqual(['all-rates:t1']);
  });

  it('iterates tenantIds and creates missing bases before draining', async () => {
    const { registry, jobs, repo, calls } = setup();
    repo.tenants = ['t1', 't2'];
    jobs.onModuleInit();

    await registry.get('payment-allocations.sweep')?.handle({}, {} as never);

    expect(calls).toEqual([
      'rates:t1:50',
      'bases:t1:50',
      'drain:t1:null:undefined',
      'rates:t2:50',
      'bases:t2:50',
      'drain:t2:null:undefined',
    ]);
  });

  // DX-375: primero congela la tasa de los abonos que la esperan, para que la
  // base nazca de la tasa congelada; si falla, sigue con las bases.
  it('si congelar las tasas falla, crea las bases y drena igual (DX-375)', async () => {
    const { jobs, repo, rebalancer, calls } = setup();
    repo.tenants = ['t1'];
    rebalancer.freezePendingRates.mockRejectedValueOnce(new Error('caída'));
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await jobs.sweep();

    expect(calls).toEqual(['bases:t1:50', 'drain:t1:null:undefined']);
    expect(warn).toHaveBeenCalledWith({
      event: 'payments.exchange_rates_freeze_failed',
      tenantId: 't1',
      error: 'Error',
    });
  });

  it('si crear las bases falla, drena igual y sigue con las demás clínicas', async () => {
    const { jobs, repo, rebalancer, calls } = setup();
    repo.tenants = ['t1', 't2'];
    rebalancer.createMissingBases.mockRejectedValueOnce(new Error('caída'));
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await jobs.sweep();

    expect(calls).toEqual([
      'rates:t1:50',
      'drain:t1:null:undefined',
      'rates:t2:50',
      'bases:t2:50',
      'drain:t2:null:undefined',
    ]);
    expect(warn).toHaveBeenCalledWith({
      event: 'payments.allocation_bases_failed',
      tenantId: 't1',
      error: 'Error',
    });
  });
});
