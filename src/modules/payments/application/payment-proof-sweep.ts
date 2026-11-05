import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import {
  FILE_STORAGE,
  type FileStoragePort,
} from '../../../shared/storage/file-storage.port';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  PENDING_PROOF_MAX_AGE_MS,
  PENDING_PROOF_PREFIX,
} from '../domain/payment-proof';
import {
  PAYMENT_REPOSITORY,
  type PaymentRepository,
} from '../domain/ports/payment-repository.port';

export const PROOF_PENDING_SWEEP_JOB = 'payments.proof-pending-sweep';
export const PROOF_PENDING_SWEEP_SCHEDULE =
  'payments.proof-pending-sweep.daily';
/** Cada día a las 04:17 UTC (un ejecutor por tick; nunca dos a la vez). */
export const PROOF_PENDING_SWEEP_CRON = '17 4 * * *';
/** Tope de borrados por pasada: lo que sobre lo recoge la siguiente. */
export const PROOF_SWEEP_MAX_DELETES = 1000;
const PAGE_SIZE = 200;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PENDING_KEY = new RegExp(`^${PENDING_PROOF_PREFIX}(${UUID})/${UUID}$`);

export interface ProofSweepResult {
  scanned: number;
  deleted: number;
  /** Con fila (no debería ocurrir: una clave pendiente nunca es la de una fila) o malformados. */
  skipped: number;
  /** El almacén no deja listar (AccessDenied): barrido desactivado, la regla del bucket cubre. */
  disabled?: boolean;
}

/** AccessDenied de S3/R2/MinIO (403) sin `s3:ListBucket`. */
export function isAccessDenied(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  return e.name === 'AccessDenied' || e.$metadata?.httpStatusCode === 403;
}

/**
 * DX-389 (M1): barrido de los comprobantes subidos que nadie entregó a un
 * abono (modal abandonado, medio cambiado a «no pide», 400/409 con el pendiente
 * conservado para reintentar, borrado fallido). Borra de `payment-proofs/pending/`
 * lo que tenga más de 24 h y no esté referenciado por ninguna fila. Es la red
 * de la aplicación: la regla de ciclo de vida del bucket (README, despliegue)
 * hace lo mismo, y cada una cubre el fallo de la otra. Idempotente.
 */
@Injectable()
export class PaymentProofPendingSweep {
  private readonly logger = new Logger('PaymentProofs');

  constructor(
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
    @Inject(PAYMENT_REPOSITORY) private readonly repo: PaymentRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async run(now: Date, signal?: AbortSignal): Promise<ProofSweepResult> {
    const cutoff = now.getTime() - PENDING_PROOF_MAX_AGE_MS;
    const result: ProofSweepResult = { scanned: 0, deleted: 0, skipped: 0 };
    let token: string | null = null;
    do {
      let page;
      try {
        page = await this.storage.listObjects(PENDING_PROOF_PREFIX, {
          token,
          maxKeys: PAGE_SIZE,
        });
      } catch (error) {
        if (!isAccessDenied(error)) throw error;
        // Sin `s3:ListBucket` (la política mínima de DX-084 no lo trae): el
        // barrido queda desactivado, UN aviso con el tipo del error (sin
        // traza) y el trabajo termina bien. La regla de ciclo de vida del
        // bucket sigue siendo la que limpia.
        this.logger.warn(
          `Barrido de comprobantes pendientes desactivado: el almacén no deja listar (${error instanceof Error ? error.name : 'AccessDenied'}). Concede s3:ListBucket sobre payment-proofs/pending/ o confía en la regla de ciclo de vida.`,
        );
        return { ...result, disabled: true };
      }
      for (const object of page.objects) {
        if (signal?.aborted || result.deleted >= PROOF_SWEEP_MAX_DELETES) {
          return result;
        }
        result.scanned += 1;
        if (object.lastModified.getTime() >= cutoff) continue;
        const tenantId = PENDING_KEY.exec(object.key)?.[1];
        if (!tenantId || (await this.referenced(tenantId, object.key))) {
          result.skipped += 1;
          continue;
        }
        // Excepción justificada al borrado blando: es un OBJETO del bucket sin fila.
        // eslint-disable-next-line no-restricted-syntax
        await this.storage.delete(object.key);
        result.deleted += 1;
      }
      token = page.nextToken;
    } while (token !== null);
    if (result.deleted > 0 || result.skipped > 0) {
      this.logger.log(
        `Barrido de comprobantes pendientes: ${result.deleted} borrados, ${result.skipped} omitidos de ${result.scanned}`,
      );
    }
    return result;
  }

  private referenced(tenantId: string, key: string): Promise<boolean> {
    return this.tenantContext.run(tenantId, () => this.repo.proofKeyInUse(key));
  }
}

/**
 * Registra el barrido en la cola de DX-085 como tarea programada: no encola
 * nada al arrancar (el bootstrap no espera a la cola, como el arreglo de
 * DX-224) y `singleton` evita dos pasadas a la vez.
 */
@Injectable()
export class PaymentProofJobs implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly sweep: PaymentProofPendingSweep,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: PROOF_PENDING_SWEEP_JOB,
      maxAttempts: 2,
      handle: async (_payload, context) => {
        await this.sweep.run(new Date(), context.signal);
      },
    });
    this.registry.schedule({
      name: PROOF_PENDING_SWEEP_SCHEDULE,
      cron: PROOF_PENDING_SWEEP_CRON,
      job: PROOF_PENDING_SWEEP_JOB,
      singleton: true,
    });
  }
}
