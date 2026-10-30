import { Logger } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import { parseCron } from '../../jobs/domain/cron';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { PaymentAllocationJobs } from './payment-allocation-jobs';
import { ExchangeSourceChangeHooks } from '../../exchange/application/exchange-source-change-hooks';
import type { PlanAllocationRebalancer } from './plan-allocation-rebalancer';
import type { PaymentBaseRetries } from './payment-base-retries';

function setup() {
  const tenantContext = new TenantContextService();
  const calls: string[] = [];
  const rebalancer = {
    freezeAllPending: jest.fn(() => {
      calls.push(`all-rates:${tenantContext.getTenantId()}`);
      return Promise.resolve({ frozen: 0, withoutRate: 0 });
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
  const due: string[] = [];
  const retries = {
    dueTenantIds: jest.fn(() => Promise.resolve([...due])),
    retryDue: jest.fn((limit: number) => {
      calls.push(`retry:${tenantContext.getTenantId()}:${limit}`);
      return Promise.resolve({ resolved: 0, withoutRate: 0, failed: 0 });
    }),
    wake: jest.fn(() => {
      calls.push(`wake:${tenantContext.getTenantId()}`);
      return Promise.resolve(0);
    }),
  };
  const registry = new JobRegistry();
  const hooks = new ExchangeSourceChangeHooks();
  const jobs = new PaymentAllocationJobs(
    registry,
    rebalancer as unknown as PlanAllocationRebalancer,
    retries as unknown as PaymentBaseRetries,
    tenantContext,
    hooks,
  );
  return {
    registry,
    jobs,
    due,
    rebalancer,
    retries,
    calls,
    hooks,
    tenantContext,
  };
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

  // DX-380: registrar o corregir una tasa, o cambiar de fuente, adelanta los
  // reintentos aplazados de la clínica (el aviso dice «en un minuto»).
  it('adelanta los reintentos de la clínica cuando cambian sus tasas o su fuente', async () => {
    const { jobs, hooks, calls, tenantContext } = setup();
    jobs.onModuleInit();

    await tenantContext.run('t1', () => hooks.afterRatesChange());

    expect(calls).toEqual(['wake:t1']);
  });

  it('es una tarea singleton: un tick no se solapa con el anterior (OPS-046)', () => {
    const { registry, jobs } = setup();
    jobs.onModuleInit();

    expect(registry.schedules()[0].singleton).toBe(true);
  });

  // DX-380 (DB-056): solo las clínicas con pendientes abren transacción.
  it('con 100 clínicas y 1 pendiente, solo entra en esa: reintenta y drena', async () => {
    const { registry, jobs, due, calls, tenantContext } = setup();
    due.push('t42');
    const run = jest.spyOn(tenantContext, 'run');
    jobs.onModuleInit();

    await registry.get('payment-allocations.sweep')?.handle({}, {} as never);

    expect(run).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['retry:t42:50', 'drain:t42:null:undefined']);
  });

  it('si los reintentos fallan, drena igual y sigue con las demás clínicas', async () => {
    const { jobs, due, retries, calls } = setup();
    due.push('t1', 't2');
    retries.retryDue.mockRejectedValueOnce(new Error('caída'));
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await jobs.sweep();

    expect(calls).toEqual([
      'drain:t1:null:undefined',
      'retry:t2:50',
      'drain:t2:null:undefined',
    ]);
    expect(warn).toHaveBeenCalledWith({
      event: 'payments.allocation_retries_failed',
      tenantId: 't1',
      error: 'Error',
    });
  });
});
