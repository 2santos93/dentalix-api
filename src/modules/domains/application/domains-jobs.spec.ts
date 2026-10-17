import { JobRegistry } from '../../jobs/application/job-registry';
import { parseCron } from '../../jobs/domain/cron';
import { DomainsJobs } from './domains-jobs';
import type { DomainRecheckSweep, RecheckDomain } from './domain-recheck';

describe('DomainsJobs (SEC-009)', () => {
  it('registra la comprobación, el barrido y su tarea horaria en la cola de DX-085', async () => {
    const registry = new JobRegistry();
    const sweep = { run: jest.fn().mockResolvedValue(0) };
    const recheck = { handle: jest.fn().mockResolvedValue(undefined) };
    new DomainsJobs(
      registry,
      sweep as unknown as DomainRecheckSweep,
      recheck as unknown as RecheckDomain,
    ).onModuleInit();

    expect(registry.names()).toEqual([
      'domains.recheck',
      'domains.recheck-sweep',
    ]);
    expect(registry.get('domains.recheck')?.maxAttempts).toBe(3);
    const [schedule] = registry.schedules();
    expect(schedule).toMatchObject({
      name: 'domains.recheck-sweep.hourly',
      job: 'domains.recheck-sweep',
    });
    // Una vez por hora.
    const first = parseCron(schedule.cron).next(
      new Date('2026-10-17T00:00:00Z'),
    );
    const second = parseCron(schedule.cron).next(first);
    expect(second.getTime() - first.getTime()).toBe(3_600_000);

    await registry.get('domains.recheck-sweep')?.handle({}, {} as never);
    expect(sweep.run).toHaveBeenCalled();
  });
});
