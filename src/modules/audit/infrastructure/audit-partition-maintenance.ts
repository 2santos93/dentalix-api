import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { AUDIT_PARTITION_CONFIG } from './audit-retention-config';
import type { AuditPartitionConfig } from './audit-retention-config';

/**
 * Mantiene el horizonte de particiones mensuales de `audit_events` (DX-102):
 * al arrancar y cada `maintenanceIntervalMs` llama a
 * `audit_events_ensure_partitions(n)`, idempotente y serializada en la BD con
 * un lock consultivo (seguro con varias réplicas). La migración ya deja 24
 * meses creados; si esto fallara, los eventos caerían en la partición DEFAULT
 * sin romper ninguna petición, así que un fallo solo deja un `warn`.
 * La purga NO corre aquí: la app no tiene permiso (`npm run audit:purge`).
 */
@Injectable()
export class AuditPartitionMaintenance
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('Audit');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUDIT_PARTITION_CONFIG)
    private readonly config: AuditPartitionConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensure();
    if (this.config.maintenanceIntervalMs <= 0) return;
    this.timer = setInterval(
      () => void this.ensure(),
      this.config.maintenanceIntervalMs,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async ensure(): Promise<void> {
    try {
      const [row] = await this.prisma.$queryRaw<{ created: number }[]>`
        SELECT audit_events_ensure_partitions(${this.config.monthsAhead}::int) AS created`;
      const created = Number(row?.created ?? 0);
      if (created > 0) {
        this.logger.log({ event: 'audit.partitions_created', created });
      }
    } catch (err) {
      // Solo el tipo de error: nada de SQL, parámetros ni datos.
      this.logger.warn({
        event: 'audit.partitions_failed',
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }
}
