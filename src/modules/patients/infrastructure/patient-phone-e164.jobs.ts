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
      handle: async () => {
        const tenants = await this.prisma.tenant.findMany({
          select: { id: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        let written = 0;
        for (const { id } of tenants) {
          const counts = await backfillTenantPhoneE164(this.prisma, id);
          written += counts.patientsWritten + counts.responsiblesWritten;
        }
        this.logger.log({
          event: 'patients.phone_e164_backfill',
          tenants: tenants.length,
          written,
        });
      },
    });
    this.registry.schedule({
      name: PHONE_E164_BACKFILL_SCHEDULE,
      cron: '41 * * * *',
      job: PHONE_E164_BACKFILL_JOB,
      singleton: true,
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    const hour = new Date().toISOString().slice(0, 13);
    try {
      await this.queue.enqueue(
        PHONE_E164_BACKFILL_JOB,
        {},
        { idempotencyKey: `${PHONE_E164_BACKFILL_JOB}:boot:${hour}` },
      );
    } catch (error) {
      // Encolar al arrancar es una comodidad: el barrido horario lo cubre.
      this.logger.warn({
        event: 'patients.phone_e164_backfill_enqueue_failed',
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}
