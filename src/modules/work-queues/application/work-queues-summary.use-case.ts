import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import {
  WORK_QUEUE_ROLES,
  workQueuesFor,
  type WorkQueueItem,
  type WorkQueueKey,
  type WorkQueuesSummary,
  type WorkQueueValue,
} from '../domain/work-queues';

/** Quién pide el resumen (del token, ya validado por el RolesGuard). */
export interface WorkQueueActor {
  userId: string;
  role: ClinicRole;
}

/**
 * La fuente de cada lista: el MISMO caso de uso que su `/count` (o su
 * `total`), con los mismos filtros por defecto. Cada una abre su propia
 * transacción tenant-scoped (`runWithTenant`) y lee la sede activa del
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
 * `GET /work-queues/summary` (DX-503): los recuentos de las listas del rol en
 * una sola respuesta. Las fuentes corren EN PARALELO (un número fijo de
 * consultas por lista, nunca una por fila ni por lista de más) y cada una
 * falla sola: su entrada sale `ERROR` y las demás llegan con su número.
 */
@Injectable()
export class GetWorkQueuesSummaryUseCase {
  private readonly logger = new Logger(GetWorkQueuesSummaryUseCase.name);

  constructor(
    @Inject(WORK_QUEUE_SOURCES) private readonly sources: WorkQueueSources,
    @Inject(WORK_QUEUES_CLOCK) private readonly clock: WorkQueuesClock,
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
    const generatedAt = this.clock().toISOString();
    const settled = await Promise.allSettled(
      keys.map((key) => this.sources[key](actor)),
    );
    const items = settled.map((result, i): WorkQueueItem => {
      const key = keys[i];
      if (result.status === 'fulfilled') {
        return { key, status: 'OK', ...result.value };
      }
      // Sin el detalle en la respuesta (puede llevar SQL o ids); al log, sí.
      this.logger.warn(
        `Lista ${key} sin recuento: ${errorText(result.reason)}`,
      );
      return { key, status: 'ERROR', count: null };
    });
    return { generatedAt, items };
  }
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Exportado para el test de la matriz de roles. */
export { WORK_QUEUE_ROLES };
