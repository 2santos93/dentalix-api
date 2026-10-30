import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  REMINDER_OPT_OUT_REPOSITORY,
  type ReminderOptOutRepository,
} from '../domain/ports/reminder-opt-out-repository.port';
import { ReminderClock } from './reminder-clock';

export const PURGE_OPT_OUT_LINKS_JOB = 'reminders.purge-opt-out-links';
export const PURGE_OPT_OUT_LINKS_SCHEDULE =
  'reminders.purge-opt-out-links.daily';

/** DX-085: housekeeping diario; cada clínica conserva FORCE RLS. */
@Injectable()
export class ReminderOptOutMaintenance implements OnModuleInit {
  private readonly logger = new Logger('Reminders');
  constructor(
    private readonly registry: JobRegistry,
    @Inject(REMINDER_OPT_OUT_REPOSITORY)
    private readonly links: ReminderOptOutRepository,
    private readonly context: TenantContextService,
    private readonly clock: ReminderClock,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: PURGE_OPT_OUT_LINKS_JOB,
      maxAttempts: 3,
      handle: async () => {
        const before = new Date(this.clock.now().getTime() - 90 * 86400000);
        for (const tenantId of await this.links.maintenanceTenantIds()) {
          const purged = await this.context.run(tenantId, () =>
            this.links.purgeLinks(before),
          );
          this.logger.log({
            event: 'reminders.opt_out_links_purged',
            tenantId,
            purged,
          });
        }
      },
    });
    this.registry.schedule({
      name: PURGE_OPT_OUT_LINKS_SCHEDULE,
      cron: '23 4 * * *',
      job: PURGE_OPT_OUT_LINKS_JOB,
      // DX-380 (OPS-046): sin solapar un tick con el anterior.
      singleton: true,
    });
  }
}
