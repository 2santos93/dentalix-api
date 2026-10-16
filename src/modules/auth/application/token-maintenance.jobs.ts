import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import { TOKEN_MAINTENANCE_REPOSITORY } from '../domain/ports/token-maintenance-repository.port';
import type { TokenMaintenanceRepository } from '../domain/ports/token-maintenance-repository.port';

export const PURGE_EXPIRED_TOKENS_JOB = 'auth.purge-expired-tokens';
export const PURGE_EXPIRED_TOKENS_SCHEDULE = 'auth.purge-expired-tokens.hourly';

/** Margen durante el que un enlace de un solo uso aún dice EXPIRED/USED. */
export const USER_TOKEN_GRACE_MS = 7 * 86_400_000;

/**
 * DX-085: purga programada (cada hora, minuto 17 UTC) de los tokens que ya no
 * sirven. Sustituye a la limpieza lazy que hacía cada logout/refresh sobre
 * `revoked_tokens` (una escritura más en el camino de la petición).
 */
@Injectable()
export class TokenMaintenanceJobs implements OnModuleInit {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly registry: JobRegistry,
    @Inject(TOKEN_MAINTENANCE_REPOSITORY)
    private readonly repo: TokenMaintenanceRepository,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: PURGE_EXPIRED_TOKENS_JOB,
      maxAttempts: 3,
      handle: async () => {
        const purged = await this.repo.purgeExpired(USER_TOKEN_GRACE_MS);
        this.logger.log({ event: 'auth.tokens_purged', ...purged });
      },
    });
    this.registry.schedule({
      name: PURGE_EXPIRED_TOKENS_SCHEDULE,
      cron: '17 * * * *',
      job: PURGE_EXPIRED_TOKENS_JOB,
    });
  }
}
