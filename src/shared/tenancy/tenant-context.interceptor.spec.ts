import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  ForbiddenException,
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

  describe('sedes permitidas del token (DX-089)', () => {
    /** Handler que devuelve la sede activa y la lista permitida vistas DENTRO del store. */
    function readLocationContext(tenantContext: TenantContextService) {
      return {
        handle: () =>
          new Observable((sub) => {
            sub.next({
              locationId: tenantContext.getLocationId(),
              allowed: tenantContext.getAllowedLocationIds(),
            });
            sub.complete();
          }),
      } as CallHandler;
    }

    function runWith(
      user: { loc?: string[] },
      headers: Record<string, string> = {},
      known = ['loc-1', 'loc-2'],
    ): Promise<unknown> {
      const tenantContext = new TenantContextService();
      const interceptor = new TenantContextInterceptor(
        tenantContext,
        makePrisma(known),
      );
      const ctx = makeCtx({
        tenantHost: { tenantId: 't-1' },
        user: { tenantId: 't-1', sub: 'u', role: 'RECEPTION', ...user },
        headers,
      });
      return new Promise((resolve, reject) => {
        interceptor
          .intercept(ctx, readLocationContext(tenantContext))
          .subscribe({ next: resolve, error: reject });
      });
    }

    it('cabecera con una sede NO permitida → 403 LOCATION_NOT_ALLOWED en español', async () => {
      const err = await runWith(
        { loc: ['loc-1'] },
        { 'x-location-id': 'loc-2' },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toEqual({
        statusCode: 403,
        error: 'Forbidden',
        code: 'LOCATION_NOT_ALLOWED',
        message: 'No tienes acceso a esta sede.',
      });
    });

    it('loc = [] rechaza cualquier cabecera', async () => {
      const err = await runWith(
        { loc: [] },
        { 'x-location-id': 'loc-1' },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
    });

    it('una sede de otra clínica sigue siendo 400 (antes que el 403)', async () => {
      const err = await runWith(
        { loc: ['loc-1'] },
        { 'x-location-id': 'loc-ajena' },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
    });

    it('cabecera con una sede permitida → la expone junto con la lista', async () => {
      await expect(
        runWith({ loc: ['loc-1', 'loc-2'] }, { 'x-location-id': 'loc-2' }),
      ).resolves.toEqual({ locationId: 'loc-2', allowed: ['loc-1', 'loc-2'] });
    });

    it('una sola sede y sin cabecera → se fija esa sede (auto-pin)', async () => {
      await expect(runWith({ loc: ['loc-1'] })).resolves.toEqual({
        locationId: 'loc-1',
        allowed: ['loc-1'],
      });
    });

    it('varias sedes y sin cabecera → sin sede fija, solo la lista', async () => {
      await expect(runWith({ loc: ['loc-1', 'loc-2'] })).resolves.toEqual({
        locationId: undefined,
        allowed: ['loc-1', 'loc-2'],
      });
    });

    it('loc = [] y sin cabecera → sin sede y lista vacía (no se convierte en ALL)', async () => {
      await expect(runWith({ loc: [] })).resolves.toEqual({
        locationId: undefined,
        allowed: [],
      });
    });

    it('sin claim → igual que hoy: cualquier sede de la clínica y ALL', async () => {
      await expect(runWith({}, { 'x-location-id': 'loc-2' })).resolves.toEqual({
        locationId: 'loc-2',
        allowed: 'ALL',
      });
      await expect(runWith({})).resolves.toEqual({
        locationId: undefined,
        allowed: 'ALL',
      });
    });
  });
});
