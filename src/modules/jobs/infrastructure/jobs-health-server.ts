import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JobWorker } from '../application/job-worker.service';
import { JOBS_CONFIG } from './jobs-config';
import type { JobsConfig } from './jobs-config';

/**
 * Sonda de liveness del worker (DX-220, OPS-029). El proceso
 * `APP_ROLE=worker` no tiene servidor HTTP (main.ts); con JOBS_HEALTH_PORT
 * abre este, mínimo, con UNA ruta y sin Nest ni rutas de negocio:
 *
 *   GET /health  200 {"status":"ok"} si la última vuelta del bucle terminó
 *                hace menos de 3 × JOBS_POLL_INTERVAL_MS + statement_timeout;
 *                503 {"status":"stale"} si no (bucle bloqueado). Durante el
 *                apagado, 200 {"status":"stopping"}.
 *   otra cosa    404.
 *
 * Solo ids y tiempos, nada de la cola. Sin JOBS_HEALTH_PORT no abre nada. Con
 * APP_ROLE=all la API sigue con sus propias sondas (GET /api/v1/health y
 * /health/ready), que no dependen del worker. Decisión (frente a un fichero
 * de latido en /tmp leído con un `exec`): un httpGet no necesita shell en la
 * imagen ni escribir en disco y se prueba igual en local con curl.
 */
@Injectable()
export class JobsHealthServer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('Jobs');
  private server: Server | null = null;

  constructor(
    private readonly worker: JobWorker,
    @Inject(JOBS_CONFIG) private readonly config: JobsConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.workerEnabled && this.config.healthPort !== null) {
      await this.listen(this.config.healthPort);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  /** Abre la sonda en `port` (0 = uno libre, para los tests). */
  async listen(port: number): Promise<number> {
    const server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0];
      if (req.method !== 'GET' || path !== '/health') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"status":"not_found"}');
        return;
      }
      const report = this.worker.liveness.report();
      const status = report.stopping
        ? 'stopping'
        : report.alive
          ? 'ok'
          : 'stale';
      res.writeHead(report.alive ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(
        JSON.stringify({
          status,
          lastLoopAt: report.lastLoopAt?.toISOString() ?? null,
          ageMs: report.ageMs,
          staleAfterMs: report.staleAfterMs,
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    const bound = (server.address() as AddressInfo).port;
    this.logger.log({ event: 'jobs.health_listening', port: bound });
    return bound;
  }

  /** Puerto en el que escucha, o null si la sonda está cerrada. */
  port(): number | null {
    return this.server ? (this.server.address() as AddressInfo).port : null;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
