import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Observable } from 'rxjs';
import { PublicTenantContextInterceptor } from './public-tenant-context.interceptor';
import { TenantContextService } from './tenant-context.service';
import { TenantHostRequest } from './tenant-host-request';

function makeCtx(req: Partial<TenantHostRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeHandlerThatReadsTenantContext(
  tenantContext: TenantContextService,
): CallHandler {
  return {
    handle: () =>
      new Observable<string | undefined>((subscriber) => {
        subscriber.next(tenantContext.getTenantId());
        subscriber.complete();
      }),
  };
}

describe('PublicTenantContextInterceptor', () => {
  it('runs with the host-resolved tenant in context when the host resolves', (done) => {
    const tenantContext = new TenantContextService();
    const interceptor = new PublicTenantContextInterceptor(tenantContext);
    const ctx = makeCtx({ tenantHost: { tenantId: 't-1' } });
    const next = makeHandlerThatReadsTenantContext(tenantContext);

    const seen: (string | undefined)[] = [];
    interceptor.intercept(ctx, next).subscribe({
      next: (value) => seen.push(value as string | undefined),
      complete: () => {
        expect(seen).toEqual(['t-1']);
        done();
      },
      error: done,
    });
  });

  it('runs the handler with no tenant in context (no throw) when the host does not resolve', (done) => {
    const tenantContext = new TenantContextService();
    const interceptor = new PublicTenantContextInterceptor(tenantContext);
    const ctx = makeCtx({ tenantHost: { tenantId: null } });
    const next = makeHandlerThatReadsTenantContext(tenantContext);

    const seen: (string | undefined)[] = [];
    interceptor.intercept(ctx, next).subscribe({
      next: (value) => seen.push(value as string | undefined),
      complete: () => {
        expect(seen).toEqual([undefined]);
        done();
      },
      error: done,
    });
  });

  it('runs the handler with no tenant in context when tenantHost is absent entirely', (done) => {
    const tenantContext = new TenantContextService();
    const interceptor = new PublicTenantContextInterceptor(tenantContext);
    const ctx = makeCtx({});
    const next = makeHandlerThatReadsTenantContext(tenantContext);

    interceptor.intercept(ctx, next).subscribe({
      next: (value) => expect(value).toBeUndefined(),
      complete: done,
      error: done,
    });
  });
});
