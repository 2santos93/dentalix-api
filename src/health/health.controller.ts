import {
  Controller,
  Get,
  Inject,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
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
 *   no responde, para que el balanceador saque la instancia de rotación.
 */
@SkipThrottle()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@Inject(PrismaService) private readonly db: DatabasePing) {}

  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; database: 'up' }> {
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
      // Solo el tipo de error: el mensaje del driver puede llevar la URL.
      this.logger.warn(
        `Readiness: la base de datos no responde (${error instanceof Error ? error.name : 'desconocido'})`,
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        status: 'unavailable',
        database: 'down',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
