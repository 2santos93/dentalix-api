import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  NotFoundException,
} from '@nestjs/common';
import { ThrottlerStorage, normalizeIp } from '@nestjs/throttler';
import { Observable, catchError, from } from 'rxjs';
import { RATE_LIMIT_CONFIG } from './rate-limit.config';
import type { RateLimitConfig } from './rate-limit.config';
import { brandingMissRateLimitKey } from './rate-limit.keys';
import {
  RateLimitRejectionLog,
  brandingRejections,
} from './rate-limit-rejection-log';
import { tooManyRequestsException } from './too-many-requests';

const POLICY = 'branding-miss';

interface HttpResponse {
  setHeader(name: string, value: string | number): void;
}

/**
 * DX-555: balde de FALLOS por IP de la marca por host (`branding-miss`).
 *
 * Un fallo (404: host desconocido, o mal formado y rechazado antes de la BD)
 * solo se sabe tras la consulta, así que no lo puede contar el guard. Aquí:
 * - un ACIERTO no toca este balde, ni para contar ni para mirar si está
 *   agotado: una clínica real nunca recibe 429 por fallos ajenos;
 * - cada FALLO suma 1 en el balde de su IP; mientras está por debajo del
 *   límite sale el 404 de siempre y, al pasarlo, 429 con `Retry-After` (el
 *   mismo formato que el guard) durante la ventana;
 * - cualquier otro error (5xx de la BD…) no es un fallo y sale tal cual.
 *
 * Usa el MISMO almacén que el guard (`ThrottlerStorage`, en memoria de cada
 * réplica) y la misma IP (`normalizeIp(req.ip)`, que respeta
 * `TRUST_PROXY_HOPS`).
 */
@Injectable()
export class BrandingMissLimitInterceptor implements NestInterceptor {
  /** Aviso agregado de los 429 (público para los tests). */
  readonly rejections: RateLimitRejectionLog = brandingRejections;

  constructor(
    @Inject(RATE_LIMIT_CONFIG) private readonly cfg: RateLimitConfig,
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(catchError((err: unknown) => from(this.onError(context, err))));
  }

  private async onError(
    context: ExecutionContext,
    err: unknown,
  ): Promise<never> {
    if (!(err instanceof NotFoundException)) throw err;

    const http = context.switchToHttp();
    const req = http.getRequest<{ ip?: string }>();
    const { limit, ttlMs } = this.cfg[POLICY];
    const key = brandingMissRateLimitKey(
      `${context.getClass().name}-${context.getHandler().name}-${POLICY}`,
      normalizeIp(req.ip ?? ''),
    );
    const { isBlocked, timeToBlockExpire } = await this.storage.increment(
      key,
      ttlMs,
      limit,
      ttlMs,
      POLICY,
    );
    if (!isBlocked) throw err;

    const res = http.getResponse<HttpResponse>();
    res.setHeader('Retry-After', timeToBlockExpire);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    this.rejections.record(POLICY, timeToBlockExpire);
    throw tooManyRequestsException(timeToBlockExpire);
  }
}
