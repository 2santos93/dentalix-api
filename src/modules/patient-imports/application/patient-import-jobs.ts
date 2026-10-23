import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import type { JobContext } from '../../jobs/domain/job';
import {
  BatchNotRunningError,
  PrismaPatientImportRepository,
} from '../infrastructure/prisma-patient-import.repository';
import {
  ISSUES_RETENTION_DAYS,
  PROCESS_IMPORT_JOB,
  VALIDATION_TTL_HOURS,
} from './patient-imports.use-cases';

export const EXPIRE_IMPORTS_JOB = 'patient-imports.expire-validated';
export const EXPIRE_IMPORTS_SCHEDULE = 'patient-imports.expire-validated.daily';
export const REAP_IMPORTS_JOB = 'patient-imports.reap-stuck';
export const REAP_IMPORTS_SCHEDULE = 'patient-imports.reap-stuck.hourly';
/** Filas por bloque: cada bloque es una transacción corta. */
export const IMPORT_CHUNK_SIZE = 250;
const MAX_ATTEMPTS = 5;

class ImportAbortedError extends Error {
  constructor() {
    super(
      'Importación interrumpida: el trabajo se retoma desde la última fila hecha',
    );
    this.name = 'ImportAbortedError';
  }
}

/**
 * Trabajos de la importación de pacientes (DX-107) en la cola de DX-085:
 *
 * - `patient-imports.process`: importa un lote confirmado POR BLOQUES de
 *   250 filas, cada uno en su transacción (la clínica sigue trabajando: solo
 *   se bloquean las filas del bloque). Idempotente: retoma desde las filas
 *   PENDING; al agotar los intentos el lote queda FAILED con lo hecho.
 * - `patient-imports.expire-validated` (diario): los dry-run sin confirmar de
 *   más de 24 h caducan y se vacían sus datos (el fichero nunca se guardó).
 *
 * El log solo lleva ids y contadores: nunca datos de pacientes.
 */
@Injectable()
export class PatientImportJobs implements OnModuleInit {
  private readonly logger = new Logger('PatientImports');

  constructor(
    private readonly registry: JobRegistry,
    private readonly repo: PrismaPatientImportRepository,
  ) {}

  onModuleInit(): void {
    this.registry.register<{ batchId: string }>({
      name: PROCESS_IMPORT_JOB,
      maxAttempts: MAX_ATTEMPTS,
      retryBaseMs: 10_000,
      handle: (payload, ctx) => this.process(payload.batchId, ctx),
    });
    this.registry.register({
      name: EXPIRE_IMPORTS_JOB,
      maxAttempts: 3,
      handle: async () => {
        const before = new Date(Date.now() - VALIDATION_TTL_HOURS * 3_600_000);
        const purgeBefore = new Date(
          Date.now() - ISSUES_RETENTION_DAYS * 86_400_000,
        );
        let expired = 0;
        let purged = 0;
        for (const tenantId of await this.repo.tenantIds()) {
          expired += await this.repo.expireStale(tenantId, before);
          purged += await this.repo.purgeIssues(tenantId, purgeBefore);
        }
        this.logger.log({ event: 'patient_imports.expired', expired, purged });
      },
    });
    this.registry.schedule({
      name: EXPIRE_IMPORTS_SCHEDULE,
      cron: '47 4 * * *',
      job: EXPIRE_IMPORTS_JOB,
    });
    // Lotes cuyo trabajo murió (intentos agotados, arriendo vencido): FAILED,
    // para que no bloqueen otra importación ni el deshacer. También se hace
    // al consultar o confirmar en la clínica.
    this.registry.register({
      name: REAP_IMPORTS_JOB,
      maxAttempts: 3,
      handle: async () => {
        let reaped = 0;
        for (const tenantId of await this.repo.tenantIds()) {
          reaped += await this.repo.reapStuck(tenantId);
        }
        if (reaped > 0)
          this.logger.warn({ event: 'patient_imports.reaped', reaped });
      },
    });
    this.registry.schedule({
      name: REAP_IMPORTS_SCHEDULE,
      cron: '13 * * * *',
      job: REAP_IMPORTS_JOB,
    });
  }

  async process(
    batchId: string,
    ctx: Pick<JobContext, 'attempt' | 'maxAttempts' | 'signal'>,
  ): Promise<void> {
    try {
      const batch = await this.repo.start(batchId);
      if (!batch) return;
      const channel = await this.repo.clinicDefaultChannel();
      for (;;) {
        if (ctx.signal.aborted) throw new ImportAbortedError();
        const chunk = await this.repo.processChunk(
          batch,
          IMPORT_CHUNK_SIZE,
          channel,
        );
        if (chunk.processed === 0) break;
      }
      await this.repo.finish(batchId, 'COMPLETED');
      this.logger.log({ event: 'patient_imports.completed', batchId });
    } catch (err) {
      if (err instanceof BatchNotRunningError) {
        // El lote ya no es de este trabajo (FAILED por `reapStuck`, deshecho):
        // no se escribe nada más y no se reintenta.
        this.logger.warn({
          event: 'patient_imports.not_running',
          batchId,
          status: err.status,
        });
        return;
      }
      if (
        ctx.attempt >= ctx.maxAttempts &&
        !(err instanceof ImportAbortedError)
      ) {
        await this.repo.finish(batchId, 'FAILED');
        this.logger.warn({
          event: 'patient_imports.failed',
          batchId,
          error: err instanceof Error ? err.constructor.name : typeof err,
        });
      }
      throw err;
    }
  }
}
