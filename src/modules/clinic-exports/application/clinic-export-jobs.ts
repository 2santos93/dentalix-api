import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import {
  BUILD_MAX_ATTEMPTS,
  CLINIC_EXPORT_BUILD_JOB,
  CLINIC_EXPORT_PURGE_JOB,
} from '../domain/clinic-export';
import {
  CLINIC_EXPORT_CLOCK,
  CLINIC_EXPORT_REPOSITORY,
  type ClinicExportClock,
  type ClinicExportRepository,
} from '../domain/ports/clinic-export-repository.port';
import { ClinicExportBuilder } from './clinic-export-builder';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function exportIdOf(job: string, payload: Record<string, unknown>): string {
  const { exportId } = payload;
  if (typeof exportId !== 'string' || !UUID.test(exportId)) {
    throw new Error(`${job}: payload sin exportId`);
  }
  return exportId;
}

/**
 * DX-053: registra en la cola de DX-085 la generación del ZIP (3 intentos;
 * en el último, o si el worker muere en él, la exportación queda FAILED y la
 * clínica puede pedir otra) y el borrado diferido del fichero.
 */
@Injectable()
export class ClinicExportJobs implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly builder: ClinicExportBuilder,
    @Inject(CLINIC_EXPORT_REPOSITORY)
    private readonly repo: ClinicExportRepository,
    @Inject(CLINIC_EXPORT_CLOCK) private readonly clock: ClinicExportClock,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: CLINIC_EXPORT_BUILD_JOB,
      maxAttempts: BUILD_MAX_ATTEMPTS,
      handle: async (payload, context) => {
        if (!context.tenantId) {
          throw new Error(`${CLINIC_EXPORT_BUILD_JOB}: trabajo sin clínica`);
        }
        await this.builder.build(exportIdOf(CLINIC_EXPORT_BUILD_JOB, payload), {
          tenantId: context.tenantId,
          attempt: context.attempt,
          maxAttempts: context.maxAttempts,
          signal: context.signal,
        });
      },
      // DX-422: el último intento se quedó a medias (el worker murió).
      onExhausted: async (payload) => {
        await this.repo.fail(
          exportIdOf(CLINIC_EXPORT_BUILD_JOB, payload),
          'LEASE_EXPIRED',
          this.clock(),
        );
      },
    });
    this.registry.register({
      name: CLINIC_EXPORT_PURGE_JOB,
      maxAttempts: 10,
      handle: async (payload, context) => {
        if (!context.tenantId) {
          throw new Error(`${CLINIC_EXPORT_PURGE_JOB}: trabajo sin clínica`);
        }
        await this.builder.purge(exportIdOf(CLINIC_EXPORT_PURGE_JOB, payload));
      },
    });
  }
}
