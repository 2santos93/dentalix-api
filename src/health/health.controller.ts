import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ShutdownState } from '../shared/lifecycle/shutdown-state';
import { PrismaService } from '../shared/prisma/prisma.service';

/** Lo único que la readiness necesita del cliente de Prisma. */
export interface DatabasePing {
  $queryRaw(query: TemplateStringsArray): Promise<unknown>;
}

/** Tiempo máximo del `SELECT 1` de la readiness antes de dar 503. */
export const READINESS_DB_TIMEOUT_MS = 2000;

class DatabaseTimeoutError extends Error {
  override readonly name = 'DatabaseTimeoutError';
}

/**
 * Sondas del balanceador/orquestador (DX-023). Públicas (sin guard), fuera
 * del rate limit (@SkipThrottle) y fuera de TenantHostMiddleware (ver
 * AppModule), para que ninguna dependa de la base salvo la readiness.
 *
 * - `GET /health` (liveness): el proceso vive. Nunca toca la base: una caída
 *   de Postgres no debe hacer que el orquestador reinicie la API.
 * - `GET /health/ready` (readiness): `SELECT 1` con timeout; 503 si la base
 *   no responde, para que el balanceador saque la instancia de rotación. El
 *   fallo va como `cause` del 503: el filtro global deja UNA línea warn con
 *   su tipo (DatabaseTimeoutError, PrismaClientInitializationError...), sin
 *   el mensaje del driver, que puede llevar la URL de la base.
 *   DX-083: también 503 (`status: 'draining'`, sin tocar la base) desde que
 *   llega SIGTERM, mientras la API drena (ver graceful-shutdown.ts).
 */
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PrismaService) private readonly db: DatabasePing,
    private readonly shutdown: ShutdownState = new ShutdownState(),
  ) {}

  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; database: 'up' }> {
    if (this.shutdown.draining) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        status: 'draining',
      });
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DatabaseTimeoutError()),
        READINESS_DB_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([this.db.$queryRaw`SELECT 1`, timeout]);
      return { status: 'ok', database: 'up' };
    } catch (error) {
      throw new ServiceUnavailableException(
        { statusCode: 503, status: 'unavailable', database: 'down' },
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
