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
 * (que con RLS real tampoco sería visible). Las de `inactive` vuelven con
 * `isActive: false` (SEC-014). `calls` cuenta las consultas.
 */
function makePrisma(known: string[] = [], inactive: string[] = []) {
  const calls = { findFirst: 0 };
  const prisma = {
    calls,
    runWithTenant: (_tenantId: string, fn: (tx: unknown) => unknown) =>
      Promise.resolve(
        fn({
          location: {
            findFirst: ({ where }: { where: { id: string } }) => {
              calls.findFirst += 1;
              return Promise.resolve(
                known.includes(where.id)
                  ? { id: where.id, isActive: !inactive.includes(where.id) }
                  : null,
              );
            },
          },
        }),
      ),
  };
  return prisma as never;
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

// DX-111: la cabecera X-Location-Id se valida como UUID antes de consultar.
const LOC_1 = '00000000-0000-4000-8000-000000000001';
const LOC_2 = '00000000-0000-4000-8000-000000000002';
const LOC_AJENA = '00000000-0000-4000-8000-0000000000aa';
const LOC_OTRA_CLINICA = '00000000-0000-4000-8000-0000000000bb';
const LOC_OFF = '00000000-0000-4000-8000-0000000000ff';

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
      makePrisma([LOC_1]),
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
      makePrisma([LOC_1]),
    );
    const ctx = makeCtx({
      tenantHost: { tenantId: 't-1' },
      user: { tenantId: 't-1', sub: 'u', role: 'ADMIN' },
      headers: { 'x-location-id': LOC_1 },
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
        expect(seen).toEqual([LOC_1]);
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
      makePrisma([LOC_1]),
    );
    const ctx = makeCtx({
      tenantHost: { tenantId: 't-1' },
      user: { tenantId: 't-1', sub: 'u', role: 'ADMIN' },
      headers: { 'x-location-id': LOC_OTRA_CLINICA },
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

  it('DX-111: una cabecera que no es UUID → 400 en español sin consultar la base', (done) => {
    const prisma = makePrisma([LOC_1]) as unknown as {
      calls: { findFirst: number };
    };
    const interceptor = new TenantContextInterceptor(
      new TenantContextService(),
      prisma as never,
    );
    const ctx = makeCtx({
      tenantHost: { tenantId: 't-1' },
      user: { tenantId: 't-1', sub: 'u', role: 'ADMIN' },
      headers: { 'x-location-id': 'no-es-uuid' },
    });
    const next: CallHandler = {
      handle: () => new Observable((sub) => sub.complete()),
    };

    interceptor.intercept(ctx, next).subscribe({
      error: (err: BadRequestException) => {
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.message).toBe(
          'La sede elegida no es válida. Vuelve a elegir la sede.',
        );
        expect(prisma.calls.findFirst).toBe(0);
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
      known = [LOC_1, LOC_2],
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
        { loc: [LOC_1] },
        { 'x-location-id': LOC_2 },
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
      const err = await runWith({ loc: [] }, { 'x-location-id': LOC_1 }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ForbiddenException);
    });

    it('una sede de otra clínica sigue siendo 400 (antes que el 403)', async () => {
      const err = await runWith(
        { loc: [LOC_1] },
        { 'x-location-id': LOC_AJENA },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
    });

    it('cabecera con una sede permitida → la expone junto con la lista', async () => {
      await expect(
        runWith({ loc: [LOC_1, LOC_2] }, { 'x-location-id': LOC_2 }),
      ).resolves.toEqual({ locationId: LOC_2, allowed: [LOC_1, LOC_2] });
    });

    it('una sola sede y sin cabecera → se fija esa sede (auto-pin)', async () => {
      await expect(runWith({ loc: [LOC_1] })).resolves.toEqual({
        locationId: LOC_1,
        allowed: [LOC_1],
      });
    });

    it('varias sedes y sin cabecera → sin sede fija, solo la lista', async () => {
      await expect(runWith({ loc: [LOC_1, LOC_2] })).resolves.toEqual({
        locationId: undefined,
        allowed: [LOC_1, LOC_2],
      });
    });

    it('loc = [] y sin cabecera → sin sede y lista vacía (no se convierte en ALL)', async () => {
      await expect(runWith({ loc: [] })).resolves.toEqual({
        locationId: undefined,
        allowed: [],
      });
    });

    it('sin claim → igual que hoy: cualquier sede de la clínica y ALL', async () => {
      await expect(runWith({}, { 'x-location-id': LOC_2 })).resolves.toEqual({
        locationId: LOC_2,
        allowed: 'ALL',
      });
      await expect(runWith({})).resolves.toEqual({
        locationId: undefined,
        allowed: 'ALL',
      });
    });
  });

  describe('sede desactivada (SEC-014)', () => {
    function runWith(
      method: string,
      user: { loc?: string[] },
      headers: Record<string, string> = {},
    ): { result: Promise<unknown>; calls: { findFirst: number } } {
      const tenantContext = new TenantContextService();
      const prisma = makePrisma([LOC_1, LOC_OFF], [LOC_OFF]) as unknown as {
        calls: { findFirst: number };
      };
      const interceptor = new TenantContextInterceptor(
        tenantContext,
        prisma as never,
      );
      const ctx = makeCtx({
        tenantHost: { tenantId: 't-1' },
        user: { tenantId: 't-1', sub: 'u', role: 'RECEPTION', ...user },
        headers,
        method,
      });
      const result = new Promise((resolve, reject) => {
        interceptor
          .intercept(ctx, {
            handle: () =>
              new Observable((sub) => {
                sub.next(tenantContext.getLocationId());
                sub.complete();
              }),
          })
          .subscribe({ next: resolve, error: reject });
      });
      return { result, calls: prisma.calls };
    }

    function expectInactive(err: unknown) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        code: 'LOCATION_INACTIVE',
        message:
          'Esta sede está desactivada: puedes consultar su historial, pero no registrar cambios en ella. Elige una sede activa.',
        // Nombra la sede: el cliente suelta su cabecera solo si es esta.
        locationId: LOC_OFF,
      });
    }

    it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])(
      '%s con la cabecera de una sede desactivada → 400 LOCATION_INACTIVE',
      async (method) => {
        const err = await runWith(
          method,
          {},
          {
            'x-location-id': LOC_OFF,
          },
        ).result.catch((e: unknown) => e);
        expectInactive(err);
      },
    );

    it.each(['GET', 'HEAD', 'OPTIONS'])(
      '%s con la cabecera de una sede desactivada → se lee su historial',
      async (method) => {
        await expect(
          runWith(method, {}, { 'x-location-id': LOC_OFF }).result,
        ).resolves.toBe(LOC_OFF);
      },
    );

    it('el 403 de una sede no permitida va antes que el 400 de desactivada', async () => {
      const err = await runWith(
        'POST',
        { loc: [LOC_1] },
        {
          'x-location-id': LOC_OFF,
        },
      ).result.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
    });

    it('auto-pin en una sede desactivada (token anterior): escribir → 400, leer sí', async () => {
      expectInactive(
        await runWith('POST', { loc: [LOC_OFF] }).result.catch(
          (e: unknown) => e,
        ),
      );
      await expect(runWith('GET', { loc: [LOC_OFF] }).result).resolves.toBe(
        LOC_OFF,
      );
    });

    it('una escritura en sede activa pasa con UNA sola consulta, y sin sede no consulta', async () => {
      const header = runWith('POST', {}, { 'x-location-id': LOC_1 });
      await expect(header.result).resolves.toBe(LOC_1);
      expect(header.calls.findFirst).toBe(1);
      const pinned = runWith('POST', { loc: [LOC_1] });
      await expect(pinned.result).resolves.toBe(LOC_1);
      expect(pinned.calls.findFirst).toBe(1);
      const pinnedRead = runWith('GET', { loc: [LOC_1] });
      await expect(pinnedRead.result).resolves.toBe(LOC_1);
      expect(pinnedRead.calls.findFirst).toBe(0);
      const consolidated = runWith('POST', {});
      await expect(consolidated.result).resolves.toBeUndefined();
      expect(consolidated.calls.findFirst).toBe(0);
    });
  });

  describe('locationId del cuerpo en escrituras (SEC-014)', () => {
    const ACTIVE = '11111111-1111-4111-8111-111111111111';
    const OFF = '22222222-2222-4222-8222-222222222222';
    const UNKNOWN = '33333333-3333-4333-8333-333333333333';

    function runWith(
      method: string,
      body: unknown,
      headers: Record<string, string> = {},
      loc?: string[],
    ): { result: Promise<unknown>; calls: { findFirst: number } } {
      const tenantContext = new TenantContextService();
      const prisma = makePrisma([ACTIVE, OFF], [OFF]) as unknown as {
        calls: { findFirst: number };
      };
      const interceptor = new TenantContextInterceptor(
        tenantContext,
        prisma as never,
      );
      const ctx = makeCtx({
        tenantHost: { tenantId: 't-1' },
        user: loc
          ? { tenantId: 't-1', sub: 'u', role: 'RECEPTION', loc }
          : { tenantId: 't-1', sub: 'u', role: 'ADMIN' },
        headers,
        method,
        body,
      });
      const result = new Promise((resolve, reject) => {
        interceptor
          .intercept(ctx, {
            handle: () =>
              new Observable((sub) => {
                sub.next('handled');
                sub.complete();
              }),
          })
          .subscribe({ next: resolve, error: reject });
      });
      return { result, calls: prisma.calls };
    }

    it('alta con la sede del cuerpo desactivada → 400 LOCATION_INACTIVE, sin llegar al handler', async () => {
      for (const method of ['POST', 'PUT', 'PATCH']) {
        const err = await runWith(method, { locationId: OFF }).result.catch(
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: 'LOCATION_INACTIVE',
          locationId: OFF,
        });
      }
    });

    it('aunque la cabecera sea de una sede activa', async () => {
      const err = await runWith(
        'POST',
        { locationId: OFF },
        { 'x-location-id': ACTIVE },
      ).result.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      // Es la del cuerpo, no la de la cabecera: el cliente no la suelta.
      expect((err as BadRequestException).getResponse()).toMatchObject({
        locationId: OFF,
      });
    });

    it('sede activa: pasa con una consulta; la misma que la cabecera, sin otra', async () => {
      const body = runWith('POST', { locationId: ACTIVE });
      await expect(body.result).resolves.toBe('handled');
      expect(body.calls.findFirst).toBe(1);
      const same = runWith(
        'POST',
        { locationId: ACTIVE },
        { 'x-location-id': ACTIVE },
      );
      await expect(same.result).resolves.toBe('handled');
      expect(same.calls.findFirst).toBe(1);
    });

    it('miembro acotado y sede del cuerpo fuera de las suyas: no la mira (el 403 del caso de uso va primero)', async () => {
      const run = runWith('POST', { locationId: OFF }, {}, [ACTIVE]);
      await expect(run.result).resolves.toBe('handled');
      // Solo la del auto-pin (ACTIVE): la desactivada ajena ni se consulta.
      expect(run.calls.findFirst).toBe(1);
      const own = runWith('POST', { locationId: OFF }, {}, [ACTIVE, OFF]);
      await expect(own.result).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lecturas, null, sin locationId, no UUID o sede desconocida: no decide aquí', async () => {
      const cases: [string, unknown, number][] = [
        ['GET', { locationId: OFF }, 0],
        ['POST', { locationId: null }, 0],
        ['POST', { name: 'Sillón 1' }, 0],
        ['POST', undefined, 0],
        ['POST', { locationId: 'norte' }, 0],
        ['POST', { locationId: UNKNOWN }, 1],
      ];
      for (const [method, body, queries] of cases) {
        const run = runWith(method, body);
        await expect(run.result).resolves.toBe('handled');
        expect(run.calls.findFirst).toBe(queries);
      }
    });
  });
});
