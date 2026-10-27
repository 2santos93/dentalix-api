import { JobRegistry } from '../../jobs/application/job-registry';
import { jobRetryDelayMs } from '../../jobs/domain/backoff';
import { loadJobsConfig } from '../../jobs/infrastructure/jobs-config';
import { LOCATION_REGIONAL_BACKFILL_CRON } from '../../locations/infrastructure/jobs/location-regional-backfill.job';
import type { PlanReminders } from './plan-reminders';
import { SEND_REMINDER_JOB } from './plan-reminders';
import { RemindersJobs } from './reminders-jobs';
import type { SendAppointmentReminder } from './send-appointment-reminder';

describe('RemindersJobs', () => {
  it('M13 (DX-350): los reintentos del envío cubren un barrido de sedes (5 min)', () => {
    const registry = new JobRegistry();
    new RemindersJobs(
      registry,
      {} as PlanReminders,
      {} as SendAppointmentReminder,
    ).onModuleInit();
    const definition = registry.get(SEND_REMINDER_JOB);
    const config = loadJobsConfig(() => undefined);
    const maxAttempts = definition?.maxAttempts ?? config.maxAttempts;
    const baseMs = definition?.retryBaseMs ?? config.retryBaseMs;
    // Del primer intento al último: la suma de las esperas entre intentos.
    let windowMs = 0;
    for (let attempt = 1; attempt < maxAttempts; attempt++) {
      windowMs += jobRetryDelayMs(attempt, baseMs);
    }
    // Una sede sin reloj (réplica anterior a G1-B) la rellena el barrido
    // `*/5`: el recordatorio que falla con 409 se reintenta después de él.
    expect(LOCATION_REGIONAL_BACKFILL_CRON).toBe('*/5 * * * *');
    expect(windowMs).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
