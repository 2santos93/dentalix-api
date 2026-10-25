import { Logger } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  ReminderOptOutMaintenance,
  PURGE_OPT_OUT_LINKS_JOB,
} from './reminder-opt-out-maintenance';

it('purga diaria DX085 por tenant con corte90d y logs solo técnicos', async () => {
  const registry = new JobRegistry();
  const context = new TenantContextService();
  const now = new Date('2026-10-23T12:00:00Z');
  const purgeLinks = jest.fn(() => {
    expect(['clinic-a', 'clinic-b']).toContain(context.getTenantId());
    return Promise.resolve(2);
  });
  const log = jest
    .spyOn(Logger.prototype, 'log')
    .mockImplementation(() => undefined);
  try {
    new ReminderOptOutMaintenance(
      registry,
      {
        purgeLinks,
        maintenanceTenantIds: () => Promise.resolve(['clinic-a', 'clinic-b']),
      } as never,
      context,
      { now: () => now },
    ).onModuleInit();
    expect(registry.schedules()).toEqual([
      expect.objectContaining({
        cron: '23 4 * * *',
        job: PURGE_OPT_OUT_LINKS_JOB,
      }),
    ]);
    await registry.get(PURGE_OPT_OUT_LINKS_JOB)!.handle({}, {} as never);
    expect(purgeLinks).toHaveBeenCalledTimes(2);
    expect(purgeLinks).toHaveBeenCalledWith(
      new Date(now.getTime() - 90 * 86400000),
    );
    expect(log.mock.calls).toEqual([
      [
        {
          event: 'reminders.opt_out_links_purged',
          tenantId: 'clinic-a',
          purged: 2,
        },
      ],
      [
        {
          event: 'reminders.opt_out_links_purged',
          tenantId: 'clinic-b',
          purged: 2,
        },
      ],
    ]);
  } finally {
    log.mockRestore();
  }
});
