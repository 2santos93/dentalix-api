import { INestApplication, Logger } from '@nestjs/common';
import type { Server } from 'node:http';
import { ShutdownState } from '../shared/lifecycle/shutdown-state';
import type { ShutdownConfig } from './shutdown-config';

/** Lo que el apagado necesita del proceso (los e2e pasan uno falso). */
export interface ShutdownProcess {
  once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  exit(code: number): void;
}

export interface GracefulShutdown {
  /** Lo que hace la señal; los e2e lo llaman directamente. */
  shutdown: (signal: string) => Promise<void>;
}

/** Cada cuánto se cierran las conexiones keep-alive que quedan ociosas. */
const IDLE_SWEEP_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deja de aceptar conexiones y espera a que terminen las peticiones en vuelo.
 * `server.close()` no corta las conexiones keep-alive que se quedan ociosas al
 * acabar su respuesta (esperarían a `keepAliveTimeout`, 65 s): se cierran en
 * cuanto se quedan ociosas. Resuelve `false` si vence `deadline` (entonces
 * corta todas las conexiones).
 */
function closeHttpServer(server: Server, deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve(true);
      return;
    }
    const sweep = setInterval(
      () => server.closeIdleConnections(),
      IDLE_SWEEP_MS,
    );
    const timer = setTimeout(
      () => {
        clearInterval(sweep);
        server.closeAllConnections();
        resolve(false);
      },
      Math.max(0, deadline - Date.now()),
    );
    server.close(() => {
      clearInterval(sweep);
      clearTimeout(timer);
      resolve(true);
    });
    server.closeIdleConnections();
  });
}

/**
 * Apagado ordenado de la API con SIGTERM/SIGINT (DX-083, OPS-004/OPS-022),
 * en este orden y sin `enableShutdownHooks` (que llamaría a `app.close()` al
 * momento: `$disconnect` y la espera del despachador ANTES de cerrar el
 * servidor HTTP, con peticiones aún en vuelo):
 *
 * 1. `/health/ready` da 503 (ShutdownState), sin cerrar nada todavía.
 * 2. Espera `drainMs`, atendiendo, a que el balanceador saque la instancia.
 * 3. Cierra el servidor HTTP: no acepta conexiones nuevas y espera a las
 *    peticiones (y transacciones) en vuelo.
 * 4. `app.close()`: hooks de Nest (despachador de email, worker con
 *    APP_ROLE=all, `$disconnect` de Prisma).
 *
 * 3 + 4 tienen el tope `timeoutMs`; si vence, sale con código 1.
 */
export function installGracefulShutdown(
  app: INestApplication,
  config: ShutdownConfig,
  proc: ShutdownProcess = process,
): GracefulShutdown {
  const logger = new Logger('Shutdown');
  const state = app.get(ShutdownState);
  let running: Promise<void> | undefined;

  const run = async (signal: string): Promise<void> => {
    state.startDraining();
    logger.log({ event: 'shutdown.draining', signal, drainMs: config.drainMs });
    await delay(config.drainMs);

    const deadline = Date.now() + config.timeoutMs;
    const closed = await closeHttpServer(
      app.getHttpServer() as Server,
      deadline,
    );
    if (!closed) {
      logger.warn({
        event: 'shutdown.http_timeout',
        timeoutMs: config.timeoutMs,
      });
    }

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(
        () => resolve('timeout'),
        Math.max(0, deadline - Date.now()),
      );
    });
    try {
      const result = await Promise.race([
        app.close().then(() => 'closed' as const),
        timedOut,
      ]);
      if (result === 'timeout' || !closed) {
        logger.error({
          event: 'shutdown.timeout',
          timeoutMs: config.timeoutMs,
        });
        proc.exit(1);
        return;
      }
    } catch (err: unknown) {
      logger.error({
        event: 'shutdown.failed',
        error: err instanceof Error ? err.name : 'unknown',
      });
      proc.exit(1);
      return;
    } finally {
      clearTimeout(timer);
    }
    logger.log({ event: 'shutdown.done' });
    proc.exit(0);
  };

  const shutdown = (signal: string): Promise<void> => {
    running ??= run(signal);
    return running;
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    proc.once(signal, () => void shutdown(signal));
  }
  return { shutdown };
}
