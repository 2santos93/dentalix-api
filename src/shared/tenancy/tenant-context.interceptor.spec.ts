import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { TenantContextService } from './tenant-context.service';
import { TenantHostRequest } from './tenant-host-request';

/**
 * PrismaService falso para la validación de la sede: `runWithTenant(tenantId, fn)`
 * ejecuta el callback con un `tx` cuyo `location.findFirst` devuelve la sede
 * solo si su id está en `known` — así se puede simular "sede de otra clínica"
 * (que con RLS real tampoco sería visible).
 */
function makePrisma(known: string[] = []) {
  return {
    runWithTenant: (_tenantId: string, fn: (tx: unknown) => unknown) =>
      Promise.resolve(
        fn({
          location: {
            findFirst: ({ where }: { where: { id: string } }) =>
              Promise.resolve(
                known.includes(where.id) ? { id: where.id } : null,
              ),
          },
        }),
      ),
  } as never;
}

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
    const interceptor = new TenantContextInterceptor(
      tenantContext,
      makePrisma(),
    );
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
    const interceptor = new TenantContextInterceptor(
      tenantContext,
      makePrisma(),
    );
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
    const interceptor = new TenantContextInterceptor(
      tenantContext,
      makePrisma(),
    );
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

  it('sin cabecera X-Location-Id deja la sede sin fijar (vista consolidada)', (done) => {
    const tenantContext = new TenantContextService();
    const interceptor = new TenantContextInterceptor(
      tenantContext,
      makePrisma(['loc-1']),
    );
    const ctx = makeCtx({
      tenantHost: { tenantId: 't-1' },
      user: { tenantId: 't-1', sub: 'u', role: 'ADMIN' },
    });
    const next: CallHandler = {
      handle: () =>
        new Observable<string | undefined>((sub) => {
          sub.next(tenantContext.getLocationId());
          sub.complete();
        }),
    };

    const seen: (string | undefined)[] = [];
    interceptor.intercept(ctx, next).subscribe({
      next: (v) => seen.push(v as string | undefined),
      complete: () => {
        expect(seen).toEqual([undefined]);
        done();
      },
    });
  });

  it('con una sede válida la expone al handler', (done) => {
    const tenantContext = new TenantContextService();
    const interceptor = new TenantContextInterceptor(
      tenantContext,
      makePrisma(['loc-1']),
    );
    const ctx = makeCtx({
      tenantHost: { tenantId: 't-1' },
      user: { tenantId: 't-1', sub: 'u', role: 'ADMIN' },
      headers: { 'x-location-id': 'loc-1' },
    });
    const next: CallHandler = {
      handle: () =>
        new Observable<string | undefined>((sub) => {
          sub.next(tenantContext.getLocationId());
          sub.complete();
        }),
    };

    const seen: (string | undefined)[] = [];
    interceptor.intercept(ctx, next).subscribe({
      next: (v) => seen.push(v as string | undefined),
      complete: () => {
        expect(seen).toEqual(['loc-1']);
        done();
      },
    });
  });

  it('RECHAZA una sede que no es de esta clínica en vez de ignorarla', (done) => {
    // Ignorarla devolvería datos de la sede equivocada (o de toda la clínica)
    // sin avisar a nadie; es preferible fallar.
    const tenantContext = new TenantContextService();
    const interceptor = new TenantContextInterceptor(
      tenantContext,
      makePrisma(['loc-1']),
    );
    const ctx = makeCtx({
      tenantHost: { tenantId: 't-1' },
      user: { tenantId: 't-1', sub: 'u', role: 'ADMIN' },
      headers: { 'x-location-id': 'loc-de-otra-clinica' },
    });
    const next: CallHandler = {
      handle: () => new Observable((sub) => sub.complete()),
    };

    interceptor.intercept(ctx, next).subscribe({
      error: (err) => {
        expect(err).toBeInstanceOf(BadRequestException);
        done();
      },
    });
  });
});
