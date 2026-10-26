import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { lastValueFrom, Observable, of, throwError } from 'rxjs';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { PlanAllocationRebalancer } from '../application/plan-allocation-rebalancer';
import {
  DrainAllocationRebalancesInterceptor,
  type DrainRequest,
} from './drain-allocation-rebalances.interceptor';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PLAN = '33333333-3333-4333-8333-333333333333';

function ctx(req: DrainRequest): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const next = <T>(observable: Observable<T>): CallHandler<T> => ({
  handle: () => observable,
});

const req = (overrides: Partial<DrainRequest> = {}): DrainRequest => ({
  method: 'POST',
  params: { id: PLAN },
  route: { path: '/api/v1/treatment-plans/:id/payments' },
  user: { sub: USER },
  ...overrides,
});

function setup(drain?: () => Promise<number>) {
  const tenantContext = new TenantContextService();
  const seenTenants: (string | undefined)[] = [];
  const drainPending = jest.fn(() => {
    seenTenants.push(tenantContext.getTenantId());
    return drain ? drain() : Promise.resolve(1);
  });
  const interceptor = new DrainAllocationRebalancesInterceptor(
    { drainPending } as unknown as PlanAllocationRebalancer,
    tenantContext,
  );
  const run = <T>(request: DrainRequest, handler: CallHandler<T>) =>
    tenantContext.run(TENANT, () =>
      lastValueFrom(interceptor.intercept(ctx(request), handler)),
    ) as Promise<T>;
  return { drainPending, seenTenants, run };
}

describe('DrainAllocationRebalancesInterceptor (DX-051)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('drains after a successful non-GET inside the tenant context', async () => {
    const { drainPending, seenTenants, run } = setup();

    await expect(run(req(), next(of({ ok: true })))).resolves.toEqual({
      ok: true,
    });

    expect(drainPending).toHaveBeenCalledTimes(1);
    expect(seenTenants).toEqual([TENANT]);
  });

  it('drains the route plan first and at most 5 plans', async () => {
    const { drainPending, run } = setup();

    await run(req(), next(of(null)));
    await run(
      req({
        method: 'POST',
        params: { patientId: USER, planId: PLAN },
        route: {
          path: '/api/v1/patients/:patientId/treatment-plans/:planId/acceptance',
        },
      }),
      next(of(null)),
    );
    // `payments/:id` y `appointments/:id/...`: el id no es de un plan.
    await run(
      req({
        method: 'DELETE',
        route: { path: '/api/v1/payments/:id' },
      }),
      next(of(null)),
    );

    expect(drainPending.mock.calls).toEqual([
      [{ actorId: USER, preferPlanId: PLAN, limit: 5 }],
      [{ actorId: USER, preferPlanId: PLAN, limit: 5 }],
      [{ actorId: USER, preferPlanId: undefined, limit: 5 }],
    ]);
  });

  it('awaits the drain before the response', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const events: string[] = [];
    const { run } = setup(async () => {
      await gate;
      events.push('drained');
      return 1;
    });

    const response = run(req(), next(of('body'))).then((body) => {
      events.push(`response:${body}`);
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual([]);
    release();
    await response;

    expect(events).toEqual(['drained', 'response:body']);
  });

  it('does not drain on GET or on error', async () => {
    const { drainPending, run } = setup();

    await run(req({ method: 'GET' }), next(of('x')));
    await expect(
      run(req(), next(throwError(() => new BadRequestException('no')))),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(drainPending).not.toHaveBeenCalled();
  });

  it('a drain failure does not fail the request', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { run } = setup(() => Promise.reject(new Error('caída')));

    await expect(run(req(), next(of('body')))).resolves.toBe('body');
    expect(warn).toHaveBeenCalledWith({
      event: 'payments.allocation_drain_failed',
      error: 'Error',
    });
  });
});
