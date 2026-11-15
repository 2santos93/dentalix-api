import {
  HttpException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { CreateAppointmentUseCase } from '../../appointments/application/use-cases/create-appointment.use-case';
import {
  HOLIDAY_MESSAGE,
  isLocationHoliday,
} from '../domain/appointment-sheet';
import type { RowIssue } from '../domain/row-validation';
import { JobRegistry } from '../../jobs/application/job-registry';
import { civilDateIn } from '../../../shared/time/civil-day';
import type { JobContext } from '../../jobs/domain/job';
import {
  BatchNotRunningError,
  PrismaPatientImportRepository,
  type BatchRow,
  type PendingAppointmentRow,
} from '../infrastructure/prisma-patient-import.repository';
import {
  APPOINTMENT_PATIENT_MISSING_MESSAGE,
  ISSUES_RETENTION_DAYS,
  PROCESS_IMPORT_JOB,
  VALIDATION_TTL_HOURS,
  httpMessage,
} from './patient-imports.use-cases';

export const EXPIRE_IMPORTS_JOB = 'patient-imports.expire-validated';
export const EXPIRE_IMPORTS_SCHEDULE = 'patient-imports.expire-validated.daily';
export const REAP_IMPORTS_JOB = 'patient-imports.reap-stuck';
export const REAP_IMPORTS_SCHEDULE = 'patient-imports.reap-stuck.hourly';
/** Filas por bloque: cada bloque es una transacción corta. */
export const IMPORT_CHUNK_SIZE = 250;
/** Saldos migrados por bloque (DX-262): un INSERT y su refresco de cartera. */
export const BALANCE_CHUNK_SIZE = 500;
/**
 * Citas que se leen a la vez (DX-263). Cada una se crea sola, con la regla
 * de agendar y su transacción corta (como una cita a mano).
 */
export const APPOINTMENT_CHUNK_SIZE = 100;
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
 *   se bloquean las filas del bloque); después, los saldos migrados de su
 *   hoja de saldos (DX-262) en bloques de 500. Idempotente: retoma desde las
 *   filas PENDING; al agotar los intentos el lote queda FAILED con lo hecho.
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
    // DX-263: las citas importadas se crean con la regla de agendar a mano.
    private readonly createAppointment: CreateAppointmentUseCase,
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
    // Lotes cuyo trabajo murió (intentos agotados, reserva vencida): FAILED,
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
      // DX-262: los saldos, cuando ya existen todos los pacientes del lote.
      // Sin fecha en el archivo, el «hoy» de la sede del lote (aproximado).
      if (batch.balancePreparedRows > batch.balanceProcessedRows) {
        const today = civilDateIn(
          new Date(),
          await this.repo.locationTimeZone(batch.locationId),
        );
        for (;;) {
          if (ctx.signal.aborted) throw new ImportAbortedError();
          const chunk = await this.repo.processBalanceChunk(
            batch,
            BALANCE_CHUNK_SIZE,
            today,
          );
          if (chunk.processed === 0) break;
        }
      }
      // DX-263: las citas, cuando ya existen todos sus pacientes.
      if (batch.appointmentPreparedRows > batch.appointmentProcessedRows) {
        await this.processAppointments(batch, ctx);
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

  /**
   * DX-263: crea las citas preparadas del lote, una a una y en orden de
   * fila, con `CreateAppointmentUseCase.createImported` (las mismas reglas
   * que agendar a mano y las EXCLUDE de la BD como respaldo). Algo que
   * cambió desde el dry-run (una cita creada a mano a la vez, un bloqueo, un
   * festivo nuevo) rechaza SOLO esa fila, con su motivo en el informe; un
   * fallo pasajero sube y la cola reintenta. Idempotente: una cita que un
   * intento anterior ya creó para la fila se reconoce y no se repite.
   */
  private async processAppointments(
    batch: BatchRow,
    ctx: Pick<JobContext, 'signal'>,
  ): Promise<void> {
    const catalog = await this.repo.appointmentCatalog();
    const zoneOf = new Map(catalog.locations.map((l) => [l.id, l.timeZone]));
    const holidays = await this.repo.locationHolidays(
      catalog.locations.map((l) => l.id),
    );
    for (;;) {
      if (ctx.signal.aborted) throw new ImportAbortedError();
      const rows = await this.repo.pendingAppointmentRows(
        batch.id,
        APPOINTMENT_CHUNK_SIZE,
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        if (ctx.signal.aborted) throw new ImportAbortedError();
        await this.importAppointment(
          batch,
          row,
          (day, locationId) =>
            isLocationHoliday(day, holidays.get(locationId) ?? []),
          zoneOf,
        );
      }
    }
  }

  private async importAppointment(
    batch: BatchRow,
    row: PendingAppointmentRow,
    isHoliday: (day: string, locationId: string) => boolean,
    zoneOf: Map<string, string | null>,
  ): Promise<void> {
    const fail = (message: string) =>
      this.repo.markAppointmentRow(batch.id, row.id, {
        outcome: 'FAILED',
        issue: {
          row: row.rowNumber,
          column: null,
          kind: 'ERROR',
          message: `Al importar: ${message}`,
          value: null,
        } satisfies RowIssue,
      });
    const patientId = await this.repo.patientForAppointment(row.docKey);
    if (patientId === null) {
      await fail(APPOINTMENT_PATIENT_MISSING_MESSAGE);
      return;
    }
    const already = await this.repo.importedAppointmentFor(batch.id, {
      patientId,
      providerId: row.providerId,
      start: row.start,
    });
    if (already) {
      await this.repo.markAppointmentRow(batch.id, row.id, {
        outcome: 'CREATED',
        appointmentId: already,
      });
      return;
    }
    // Festivo de la sede (DX-316), en su zona; sin zona, la regla de
    // agendar da su 409.
    const zone = zoneOf.get(row.locationId);
    if (zone && isHoliday(civilDateIn(row.start, zone), row.locationId)) {
      await fail(HOLIDAY_MESSAGE);
      return;
    }
    let appointmentId: string;
    try {
      const created = await this.createAppointment.createImported({
        patientId,
        providerId: row.providerId,
        locationId: row.locationId,
        start: row.start,
        end: row.end,
        appointmentTypeId: row.appointmentTypeId ?? undefined,
        reason: row.reason ?? undefined,
        importBatchId: batch.id,
        createdById: batch.confirmedById ?? undefined,
      });
      appointmentId = created.id;
    } catch (err) {
      if (err instanceof HttpException) {
        await fail(httpMessage(err));
        return;
      }
      throw err;
    }
    await this.repo.markAppointmentRow(batch.id, row.id, {
      outcome: 'CREATED',
      appointmentId,
    });
  }
}
