import { Logger } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import { parseCron } from '../../jobs/domain/cron';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { PaymentAllocationJobs } from './payment-allocation-jobs';
import type { PlanAllocationRebalancer } from './plan-allocation-rebalancer';
import { InMemoryPlanAllocationRepository } from './__fixtures__/in-memory-plan-allocation.repository';

function setup() {
  const tenantContext = new TenantContextService();
  const repo = new InMemoryPlanAllocationRepository();
  const calls: string[] = [];
  const rebalancer = {
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
  const jobs = new PaymentAllocationJobs(
    registry,
    rebalancer as unknown as PlanAllocationRebalancer,
    repo,
    tenantContext,
  );
  return { registry, jobs, repo, rebalancer, calls };
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

  it('iterates tenantIds and creates missing bases before draining', async () => {
    const { registry, jobs, repo, calls } = setup();
    repo.tenants = ['t1', 't2'];
    jobs.onModuleInit();

    await registry.get('payment-allocations.sweep')?.handle({}, {} as never);

    expect(calls).toEqual([
      'bases:t1:50',
      'drain:t1:null:undefined',
      'bases:t2:50',
      'drain:t2:null:undefined',
    ]);
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
      'drain:t1:null:undefined',
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
