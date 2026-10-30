import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import { TOKEN_MAINTENANCE_REPOSITORY } from '../domain/ports/token-maintenance-repository.port';
import type { TokenMaintenanceRepository } from '../domain/ports/token-maintenance-repository.port';
import {
  LOGIN_LOCKOUT_CONFIG,
  type LoginLockoutConfig,
} from '../domain/login-lockout';

export const PURGE_EXPIRED_TOKENS_JOB = 'auth.purge-expired-tokens';
export const PURGE_EXPIRED_TOKENS_SCHEDULE = 'auth.purge-expired-tokens.hourly';

/** Margen durante el que un enlace de un solo uso aún dice EXPIRED/USED. */
export const USER_TOKEN_GRACE_MS = 7 * 86_400_000;

/**
 * DX-085: purga programada (cada hora, minuto 17 UTC) de los tokens que ya no
 * sirven. Sustituye a la limpieza lazy que hacía cada logout/refresh sobre
 * `revoked_tokens` (una escritura más en el camino de la petición). DX-048:
 * también los contadores de fallos de login olvidados (`login_throttles`).
 */
@Injectable()
export class TokenMaintenanceJobs implements OnModuleInit {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly registry: JobRegistry,
    @Inject(TOKEN_MAINTENANCE_REPOSITORY)
    private readonly repo: TokenMaintenanceRepository,
    @Inject(LOGIN_LOCKOUT_CONFIG)
    private readonly lockout: LoginLockoutConfig,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: PURGE_EXPIRED_TOKENS_JOB,
      maxAttempts: 3,
      handle: async () => {
        // Un contador de login sin fallos en más de lo que se recuerdan (cuenta)
        // o de lo que dura su ventana (IP) ya no cuenta para nada.
        const purged = await this.repo.purgeExpired(
          USER_TOKEN_GRACE_MS,
          Math.max(this.lockout.failureMemoryMs, this.lockout.ipWindowMs),
        );
        this.logger.log({ event: 'auth.tokens_purged', ...purged });
      },
    });
    this.registry.schedule({
      name: PURGE_EXPIRED_TOKENS_SCHEDULE,
      cron: '17 * * * *',
      job: PURGE_EXPIRED_TOKENS_JOB,
      // DX-380 (OPS-046): sin solapar un tick con el anterior.
      singleton: true,
    });
  }
}
