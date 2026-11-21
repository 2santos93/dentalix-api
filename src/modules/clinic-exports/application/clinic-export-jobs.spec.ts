import type { JobRegistry } from '../../jobs/application/job-registry';
import type { JobDefinition } from '../../jobs/domain/job';
import {
  CLINIC_EXPORT_BUILD_JOB,
  CLINIC_EXPORT_PURGE_JOB,
} from '../domain/clinic-export';
import type { ClinicExportRepository } from '../domain/ports/clinic-export-repository.port';
import type { ClinicExportBuilder } from './clinic-export-builder';
import { ClinicExportJobs } from './clinic-export-jobs';

const EXPORT_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-21T13:00:00Z');

/**
 * DX-053: los trabajos de la exportación. Con los intentos agotados (el
 * worker murió en el último), la exportación queda FAILED y su fichero, si
 * alcanzó a subirse, se borra ya.
 */
describe('ClinicExportJobs (DX-053)', () => {
  function setup() {
    const defs = new Map<string, JobDefinition>();
    const registry = {
      register: (d: JobDefinition) => defs.set(d.name, d),
    } as unknown as JobRegistry;
    const calls: string[] = [];
    const purge = jest.fn((id: string) => {
      calls.push(`purge:${id}`);
      return Promise.resolve();
    });
    const fail = jest.fn((id: string, code: string) => {
      calls.push(`fail:${id}:${code}`);
      return Promise.resolve();
    });
    const jobs = new ClinicExportJobs(
      registry,
      { purge } as unknown as ClinicExportBuilder,
      { fail } as unknown as ClinicExportRepository,
      () => NOW,
    );
    jobs.onModuleInit();
    return { defs, calls };
  }

  it('agotado: FAILED LEASE_EXPIRED y borrado del fichero, en ese orden', async () => {
    const t = setup();
    const build = t.defs.get(CLINIC_EXPORT_BUILD_JOB)!;
    await build.onExhausted!(
      { exportId: EXPORT_ID },
      { jobId: 'j', tenantId: 't1', attempts: 4 },
    );
    expect(t.calls).toEqual([
      `fail:${EXPORT_ID}:LEASE_EXPIRED`,
      `purge:${EXPORT_ID}`,
    ]);
  });

  it('el borrado diferido y la generación exigen clínica y un id válido', async () => {
    const t = setup();
    const purge = t.defs.get(CLINIC_EXPORT_PURGE_JOB)!;
    const ctx = {
      jobId: 'j',
      attempt: 1,
      maxAttempts: 10,
      tenantId: 't1',
      signal: new AbortController().signal,
    };
    await purge.handle({ exportId: EXPORT_ID }, ctx);
    expect(t.calls).toEqual([`purge:${EXPORT_ID}`]);
    await expect(purge.handle({ exportId: 'x' }, ctx)).rejects.toThrow(
      'payload sin exportId',
    );
    await expect(
      purge.handle({ exportId: EXPORT_ID }, { ...ctx, tenantId: null }),
    ).rejects.toThrow('sin clínica');
  });
});
