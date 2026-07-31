import {
  CallHandler,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { TenantContextInterceptor } from './tenant-context.interceptor';
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
        // Read INSIDE the subscription (i.e. inside the piped handler), proving
        // the tenant id is visible from within next.handle(), not just at the
        // point intercept() was called.
        subscriber.next(tenantContext.getTenantId());
        subscriber.complete();
      }),
  };
}

describe('TenantContextInterceptor', () => {
  it('runs with the host-resolved tenant when the JWT tenant matches', (done) => {
    const tenantContext = new TenantContextService();
    const interceptor = new TenantContextInterceptor(tenantContext);
    const ctx = makeCtx({
      tenantHost: { tenantId: 't-1' },
      user: { tenantId: 't-1', sub: 'u', role: 'ADMIN' },
    });
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

  it('throws UnauthorizedException when the JWT tenant differs from the host tenant', () => {
    const tenantContext = new TenantContextService();
    const interceptor = new TenantContextInterceptor(tenantContext);
    const ctx = makeCtx({
      tenantHost: { tenantId: 't-1' },
      user: { tenantId: 't-2', sub: 'u', role: 'ADMIN' },
    });
    const next = makeHandlerThatReadsTenantContext(tenantContext);
    const handleSpy = jest.spyOn(next, 'handle');

    expect(() => interceptor.intercept(ctx, next)).toThrow(
      UnauthorizedException,
    );
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('throws UnauthorizedException when the host does not resolve to a tenant', () => {
    const tenantContext = new TenantContextService();
    const interceptor = new TenantContextInterceptor(tenantContext);
    const ctx = makeCtx({
      tenantHost: { tenantId: null },
      user: { tenantId: 't-1', sub: 'u', role: 'ADMIN' },
    });
    const next = makeHandlerThatReadsTenantContext(tenantContext);
    const handleSpy = jest.spyOn(next, 'handle');

    expect(() => interceptor.intercept(ctx, next)).toThrow(
      UnauthorizedException,
    );
    expect(handleSpy).not.toHaveBeenCalled();
  });
});
