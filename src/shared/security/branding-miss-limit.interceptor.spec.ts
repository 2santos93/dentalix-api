import {
  CallHandler,
  ExecutionContext,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { firstValueFrom, of, throwError } from 'rxjs';
import { BrandingMissLimitInterceptor } from './branding-miss-limit.interceptor';
import { DEFAULT_RATE_LIMITS, RateLimitConfig } from './rate-limit.config';
import { RateLimitRejectionLog } from './rate-limit-rejection-log';
import { tooManyRequestsException } from './too-many-requests';
import { normalizeBrandingHost } from '../../modules/public-branding/application/branding-host';

// La ruta real: el prefijo de la clave sale de la clase y el handler.
class PublicBrandingByHostController {}
function branding(): void {}

const MISS_LIMIT = 3;
const cfg: RateLimitConfig = {
  ...DEFAULT_RATE_LIMITS,
  'branding-miss': { limit: MISS_LIMIT, ttlMs: 60_000 },
};

// La «BD» del caso de uso: solo esta clínica existe.
const REAL_HOST = 'sonrisa-caracas.dentalix.app';

describe('BrandingMissLimitInterceptor (DX-555)', () => {
  let storage: ThrottlerStorageService;
  let interceptor: BrandingMissLimitInterceptor;
  let warnings: unknown[];

  beforeEach(() => {
    storage = new ThrottlerStorageService();
    interceptor = new BrandingMissLimitInterceptor(cfg, storage);
    warnings = [];
    (interceptor as { rejections: RateLimitRejectionLog }).rejections =
      new RateLimitRejectionLog('GET /x', {
        warn: (m: unknown) => warnings.push(m),
      });
  });

  afterEach(() => storage.onApplicationShutdown());

  function call(ip: string, host: string) {
    const headers: Record<string, unknown> = {};
    const context = {
      getClass: () => PublicBrandingByHostController,
      getHandler: () => branding,
      switchToHttp: () => ({
        getRequest: () => ({ ip }),
        getResponse: () => ({
          setHeader: (name: string, value: unknown) => {
            headers[name] = value;
          },
        }),
      }),
    } as unknown as ExecutionContext;
    // Lo que haría el caso de uso: inválido o desconocido = 404.
    const next: CallHandler = {
      handle: () =>
        normalizeBrandingHost(host) === REAL_HOST
          ? of({ name: 'Sonrisa Caracas' })
          : throwError(() => new NotFoundException('Tenant not found')),
    };
    const result = firstValueFrom(interceptor.intercept(context, next)).then(
      (body) => ({ status: 200, body, headers }),
      (err: unknown) => ({
        status: err instanceof HttpException ? err.getStatus() : 500,
        body: err instanceof HttpException ? err.getResponse() : err,
        headers,
      }),
    );
    return result;
  }

  it('un acierto pasa y no gasta el balde de fallos', async () => {
    for (let i = 0; i < MISS_LIMIT * 5; i++) {
      expect((await call('10.0.0.1', REAL_HOST)).status).toBe(200);
    }
    // El balde de fallos de esa IP sigue entero.
    for (let i = 0; i < MISS_LIMIT; i++) {
      expect((await call('10.0.0.1', `nadie-${i}.dentalix.app`)).status).toBe(
        404,
      );
    }
    expect((await call('10.0.0.1', 'nadie-x.dentalix.app')).status).toBe(429);
  });

  it('los fallos dan 404 hasta el límite y luego 429 con Retry-After y no-store', async () => {
    for (let i = 0; i < MISS_LIMIT; i++) {
      expect((await call('10.0.0.2', `enum-${i}.dentalix.app`)).status).toBe(
        404,
      );
    }
    const res = await call('10.0.0.2', 'enum-next.dentalix.app');
    expect(res.status).toBe(429);
    const retryAfter = res.headers['Retry-After'] as number;
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['Pragma']).toBe('no-cache');
    expect(res.body).toEqual(
      tooManyRequestsException(retryAfter).getResponse(),
    );
  });

  it('un host mal formado es un fallo más', async () => {
    for (const host of ['a..b', 'x/../y', '%00']) {
      expect((await call('10.0.0.3', host)).status).toBe(404);
    }
    expect((await call('10.0.0.3', 'otro.dentalix.app')).status).toBe(429);
  });

  it('un aluvión de hosts inventados desde la IP del servidor web no bloquea a la clínica real', async () => {
    const next = '10.0.0.4';
    for (let i = 0; i < 100; i++) {
      await call(next, `inventado-${i}.dentalix.app`);
    }
    expect((await call(next, 'otro-mas.dentalix.app')).status).toBe(429);
    // La misma IP, agotada de fallos, sigue sirviendo la marca real.
    const hit = await call(next, REAL_HOST);
    expect(hit.status).toBe(200);
    expect(hit.headers['Retry-After']).toBeUndefined();
  });

  it('los baldes son por IP: el agotado de una no alcanza a otra', async () => {
    for (let i = 0; i <= MISS_LIMIT; i++) {
      await call('10.0.0.5', `enum-${i}.dentalix.app`);
    }
    expect((await call('10.0.0.5', 'enum-y.dentalix.app')).status).toBe(429);
    expect((await call('10.0.0.6', 'enum-y.dentalix.app')).status).toBe(404);
  });

  it('otros errores (p. ej. la BD caída) no son fallos ni gastan el balde', async () => {
    const context = {
      getClass: () => PublicBrandingByHostController,
      getHandler: () => branding,
      switchToHttp: () => ({ getRequest: () => ({ ip: '10.0.0.7' }) }),
    } as unknown as ExecutionContext;
    for (let i = 0; i < MISS_LIMIT * 3; i++) {
      await expect(
        firstValueFrom(
          interceptor.intercept(context, {
            handle: () =>
              throwError(() => new ServiceUnavailableException('BD caída')),
          }),
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
    expect((await call('10.0.0.7', 'nadie.dentalix.app')).status).toBe(404);
  });

  it('avisa en el log de los 429 de fallos, agregado y sin IP ni host', async () => {
    for (let i = 0; i < MISS_LIMIT + 5; i++) {
      await call('10.0.0.8', `enum-${i}.dentalix.app`);
    }
    // 5 rechazos en menos de 10 s: UNA línea (la del primero).
    expect(warnings).toEqual([
      expect.objectContaining({
        event: 'rate_limit.rejected',
        policy: 'branding-miss',
        rejected: 1,
      }),
    ]);
    expect(JSON.stringify(warnings)).not.toMatch(/10\.0\.0\.8|enum-/);
  });
});
