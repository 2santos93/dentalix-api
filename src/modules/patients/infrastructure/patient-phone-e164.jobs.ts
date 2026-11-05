import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleInit,
} from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import { JobQueue } from '../../jobs/application/job-queue.service';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { backfillTenantPhoneE164 } from './phone-e164-backfill';

export interface PhoneE164BackfillRun {
  tenantIds: readonly string[];
  backfill: (
    tenantId: string,
    shouldStop: () => boolean,
  ) => Promise<{ patientsWritten: number; responsiblesWritten: number }>;
  /** Pierde el arriendo o se apaga: dejar de producir efectos. */
  shouldStop: () => boolean;
  onTenantError: (tenantId: string, error: unknown) => void;
}

/**
 * Recorre las clínicas una a una. El fallo de una (un `57014`, un tiempo
 * agotado) se registra —id de clínica y clase del error, nunca un teléfono— y
 * NO impide rellenar las siguientes; entre clínicas y entre lotes se consulta
 * la señal del trabajo y, si se abortó, se para.
 */
export async function runPhoneE164Backfill(run: PhoneE164BackfillRun) {
  let written = 0;
  let failed = 0;
  let done = 0;
  for (const tenantId of run.tenantIds) {
    if (run.shouldStop()) break;
    try {
      const counts = await run.backfill(tenantId, run.shouldStop);
      written += counts.patientsWritten + counts.responsiblesWritten;
      done += 1;
    } catch (error) {
      failed += 1;
      run.onTenantError(tenantId, error);
    }
  }
  return {
    tenants: run.tenantIds.length,
    done,
    failed,
    written,
    stopped: run.shouldStop(),
  };
}

export const PHONE_E164_BACKFILL_JOB = 'patients.phone-e164-backfill';
export const PHONE_E164_BACKFILL_SCHEDULE =
  'patients.phone-e164-backfill.hourly';

/**
 * DX-224 (I3): «¿Quién llama?» solo encuentra a quien tiene `phoneE164`. Las
 * filas anteriores a la columna (y cualquier escritor que lo olvide) se
 * rellenan SOLAS, sin paso manual en el despliegue: un trabajo al arrancar
 * (una vez por hora de reloj y por clave de idempotencia, para no repetirlo
 * en cada reinicio de las réplicas) y un barrido cada hora (minuto 41 UTC).
 * Idempotente y por lotes; recorre clínica a clínica con su tenant fijado.
 * Solo registra recuentos, nunca un teléfono.
 */
@Injectable()
export class PatientPhoneE164Jobs
  implements OnModuleInit, OnApplicationBootstrap
{
  private readonly logger = new Logger('Patients');

  constructor(
    private readonly registry: JobRegistry,
    private readonly queue: JobQueue,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: PHONE_E164_BACKFILL_JOB,
      maxAttempts: 3,
      handle: async (_payload, { signal }) => {
        const tenants = await this.prisma.tenant.findMany({
          select: { id: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        const result = await runPhoneE164Backfill({
          tenantIds: tenants.map((t) => t.id),
          backfill: (tenantId, shouldStop) =>
            backfillTenantPhoneE164(
              this.prisma,
              tenantId,
              undefined,
              shouldStop,
            ),
          shouldStop: () => signal.aborted,
          onTenantError: (tenantId, error) =>
            this.logger.error({
              event: 'patients.phone_e164_backfill_tenant_failed',
              tenantId,
              error: error instanceof Error ? error.name : 'unknown',
            }),
        });
        this.logger.log({ event: 'patients.phone_e164_backfill', ...result });
      },
    });
    this.registry.schedule({
      name: PHONE_E164_BACKFILL_SCHEDULE,
      cron: '41 * * * *',
      job: PHONE_E164_BACKFILL_JOB,
      singleton: true,
    });
  }

  /**
   * Encola el relleno al arrancar SIN esperarlo: el arranque de la app no puede
   * depender de la cola (con la BD de la cola colgada, `await` dejaba el
   * bootstrap sin terminar: test/jobs-worker-health). Un fallo o una cola que
   * no contesta solo pierde este encolado; el barrido horario lo cubre.
   */
  onApplicationBootstrap(): void {
    const hour = new Date().toISOString().slice(0, 13);
    void this.queue
      .enqueue(
        PHONE_E164_BACKFILL_JOB,
        {},
        { idempotencyKey: `${PHONE_E164_BACKFILL_JOB}:boot:${hour}` },
      )
      .catch((error: unknown) => {
        this.logger.warn({
          event: 'patients.phone_e164_backfill_enqueue_failed',
          error: error instanceof Error ? error.name : 'unknown',
        });
      });
  }
}
