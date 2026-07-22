import { CallHandler, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Observable } from 'rxjs';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { TenantContextService } from './tenant-context.service';

function makeCtx(user?: { tenantId?: string; sub?: string; role?: string }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function makeHandlerThatReadsTenantContext(tenantContext: TenantContextService): CallHandler {
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
  it('makes the tenant id visible from inside the piped handler', (done) => {
    const tenantContext = new TenantContextService();
    const interceptor = new TenantContextInterceptor(tenantContext);
    const ctx = makeCtx({ tenantId: 't-123', sub: 'u', role: 'OWNER' });
    const next = makeHandlerThatReadsTenantContext(tenantContext);

    const seen: (string | undefined)[] = [];
    interceptor.intercept(ctx, next).subscribe({
      next: (value) => seen.push(value as string | undefined),
      complete: () => {
        expect(seen).toEqual(['t-123']);
        done();
      },
      error: done,
    });
  });

  it('throws UnauthorizedException when req.user.tenantId is missing', () => {
    const tenantContext = new TenantContextService();
    const interceptor = new TenantContextInterceptor(tenantContext);
    const ctx = makeCtx(undefined);
    const next = makeHandlerThatReadsTenantContext(tenantContext);

    expect(() => interceptor.intercept(ctx, next)).toThrow(UnauthorizedException);
  });
});
