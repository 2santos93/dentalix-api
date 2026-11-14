import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { settleWithLimit } from '../../../shared/async/settle-with-limit';
import { withTransactionBudget } from '../../../shared/prisma/transaction-budget';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  WORK_QUEUE_ROLES,
  workQueuesFor,
  type WorkQueueItem,
  type WorkQueueKey,
  type WorkQueuesSummary,
  type WorkQueueValue,
} from '../domain/work-queues';
import {
  WorkQueuesSummaryCache,
  workQueuesCacheKey,
} from './work-queues-summary.cache';

/** Quién pide el resumen (del token, ya validado por el RolesGuard). */
export interface WorkQueueActor {
  userId: string;
  role: ClinicRole;
}

/**
 * La fuente de cada lista: el MISMO caso de uso que su `/count` (o su
 * `total`), con los mismos filtros por defecto (la cartera, solo sus totales:
 * `GetReceivablesAgingUseCase.summary`). Cada una abre sus propias
 * transacciones tenant-scoped (`runWithTenant`) y lee la sede activa del
 * contexto del request, así que un fallo de una no aborta las demás.
 */
export type WorkQueueSources = Record<
  WorkQueueKey,
  (actor: WorkQueueActor) => Promise<WorkQueueValue>
>;

export const WORK_QUEUE_SOURCES = Symbol('WORK_QUEUE_SOURCES');

export type WorkQueuesClock = () => Date;
export const WORK_QUEUES_CLOCK = Symbol('WORK_QUEUES_CLOCK');

/**
 * OPS-056: conexiones del pool que puede ocupar a la vez UNA petición del
 * resumen. Es también cuántas fuentes corren a la vez. El runbook dimensiona
 * `connection_limit` con 2 transacciones por petición (README, «Pool»).
 */
export const WORK_QUEUES_MAX_CONNECTIONS = 2;

/**
 * `GET /work-queues/summary` (DX-503): los recuentos de las listas del rol en
 * una sola respuesta (un número fijo de consultas por lista, nunca una por
 * fila ni por lista de más). Cada fuente falla sola: su entrada sale `ERROR`
 * y las demás llegan con su número.
 *
 * OPS-056: la web lo pide cada minuto en cada pestaña, así que
 * - nunca ocupa más de `WORK_QUEUES_MAX_CONNECTIONS` conexiones: corren 2
 *   fuentes a la vez y, como cada una abre varias transacciones en paralelo,
 *   toda la petición va dentro de un presupuesto de 2 (`withTransactionBudget`);
 * - el resumen se guarda `WORK_QUEUES_CACHE_TTL_MS` por clínica, sede activa,
 *   sedes permitidas, rol, usuario y listas (nunca se comparte entre ellos).
 *   Una respuesta con alguna lista en `ERROR` no se guarda.
 */
@Injectable()
export class GetWorkQueuesSummaryUseCase {
  private readonly logger = new Logger(GetWorkQueuesSummaryUseCase.name);

  constructor(
    @Inject(WORK_QUEUE_SOURCES) private readonly sources: WorkQueueSources,
    @Inject(WORK_QUEUES_CLOCK) private readonly clock: WorkQueuesClock,
    private readonly tenantContext: TenantContextService,
    private readonly cache: WorkQueuesSummaryCache,
  ) {}

  async execute(
    actor: WorkQueueActor,
    only?: readonly WorkQueueKey[],
  ): Promise<WorkQueuesSummary> {
    // `only` ACOTA (el contador del menú pide dos); nunca añade una lista
    // que el rol no tiene: esa ni se calcula ni se nombra.
    const keys = workQueuesFor(actor.role).filter(
      (key) => !only || only.includes(key),
    );
    const cacheKey = this.cacheKeyFor(actor, keys);
    const cached = cacheKey === null ? undefined : this.cache.get(cacheKey);
    if (cached) return cached;
    const summary = await this.compute(actor, keys);
    if (cacheKey !== null && summary.items.every((i) => i.status === 'OK')) {
      this.cache.set(cacheKey, summary);
    }
    return summary;
  }

  private async compute(
    actor: WorkQueueActor,
    keys: readonly WorkQueueKey[],
  ): Promise<WorkQueuesSummary> {
    const generatedAt = this.clock().toISOString();
    const settled = await withTransactionBudget(
      WORK_QUEUES_MAX_CONNECTIONS,
      () =>
        settleWithLimit(keys, WORK_QUEUES_MAX_CONNECTIONS, (key) =>
          this.sources[key](actor),
        ),
    );
    const items = settled.map((result, i): WorkQueueItem => {
      const key = keys[i];
      if (result.status === 'fulfilled') {
        return { key, status: 'OK', ...result.value };
      }
      // Ni en la respuesta ni en el log va el mensaje (puede llevar SQL,
      // valores o ids): solo qué lista, el tipo de error y su código.
      this.logger.warn({
        event: 'work_queues.source_failed',
        key,
        ...errorFacts(result.reason),
      });
      return { key, status: 'ERROR', count: null };
    });
    return { generatedAt, items };
  }

  /** Sin clínica en el contexto, sin caché (no hay con qué aislarla). */
  private cacheKeyFor(
    actor: WorkQueueActor,
    keys: readonly WorkQueueKey[],
  ): string | null {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) return null;
    return workQueuesCacheKey({
      tenantId,
      locationId: this.tenantContext.getLocationId(),
      allowedLocationIds: this.tenantContext.getAllowedLocationIds(),
      role: actor.role,
      userId: actor.userId,
      keys,
    });
  }
}

function errorFacts(reason: unknown): {
  error: string;
  code: string | null;
} {
  if (reason instanceof Error) {
    const code = (reason as Error & { code?: unknown }).code;
    return {
      error: reason.name,
      code: typeof code === 'string' ? code : null,
    };
  }
  return { error: typeof reason, code: null };
}

/** Exportado para el test de la matriz de roles. */
export { WORK_QUEUE_ROLES };
