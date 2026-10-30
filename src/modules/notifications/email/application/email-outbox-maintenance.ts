import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobRegistry } from '../../../jobs/application/job-registry';
import { PrismaEmailOutboxRetentionRepository } from '../infrastructure/repositories/prisma-email-outbox-retention.repository';

export const PURGE_EMAIL_OUTBOX_JOB = 'email.purge-outbox';
export const PURGE_EMAIL_OUTBOX_SCHEDULE = 'email.purge-outbox.daily';
export const DEFAULT_OUTBOX_RETENTION_DAYS = 90;

/**
 * DX-085: cada día borra de `email_outbox` los envíos terminados (SENT o
 * FAILED) de hace más de MAIL_OUTBOX_RETENTION_DAYS (default 90, mínimo 7:
 * los topes anti-abuso miran 24 h y una invitación caduca a los 7 días, así
 * que nada vivo depende de filas más antiguas). Los PENDING/SENDING nunca se
 * tocan. Las de plataforma (sin clínica) se purgan con la misma retención
 * por la función del rol despachador (DX-144, SEC-037; ver
 * PrismaEmailOutboxRetentionRepository).
 */
@Injectable()
export class EmailOutboxMaintenance implements OnModuleInit {
  private readonly logger = new Logger('Email');

  constructor(
    private readonly registry: JobRegistry,
    private readonly repo: PrismaEmailOutboxRetentionRepository,
    private readonly config: ConfigService,
  ) {}

  private retentionDays(): number {
    const raw = this.config.get<string>('MAIL_OUTBOX_RETENTION_DAYS')?.trim();
    return raw && /^\d{1,4}$/.test(raw)
      ? Math.max(7, Number(raw))
      : DEFAULT_OUTBOX_RETENTION_DAYS;
  }

  onModuleInit(): void {
    this.registry.register({
      name: PURGE_EMAIL_OUTBOX_JOB,
      maxAttempts: 3,
      handle: async () => {
        const before = new Date(Date.now() - this.retentionDays() * 86_400_000);
        let purged = 0;
        for (const tenantId of await this.repo.tenantIds()) {
          purged += await this.repo.purgeFinished(tenantId, before);
        }
        const platformPurged = await this.repo.purgePlatformFinished(before);
        this.logger.log({
          event: 'email.outbox_purged',
          purged,
          platformPurged,
        });
      },
    });
    this.registry.schedule({
      name: PURGE_EMAIL_OUTBOX_SCHEDULE,
      cron: '23 4 * * *',
      job: PURGE_EMAIL_OUTBOX_JOB,
      // DX-380 (OPS-046): sin solapar un tick con el anterior.
      singleton: true,
    });
  }
}
