import { Inject, Injectable, Logger } from '@nestjs/common';
import { currentRequestId } from '../../../shared/observability/request-context';
import {
  PAYMENT_REPOSITORY,
  type PaymentRepository,
} from '../domain/ports/payment-repository.port';
import type { PaymentProofAttachment } from '../domain/payment-proof';
import {
  type CompletedProof,
  PaymentProofUploads,
} from './payment-proof-uploads';

/**
 * DX-389: el ciclo del comprobante de un abono dentro de quien lo registra.
 * `complete` comprueba y copia el objeto subido (justo antes de abrir la
 * transacción del abono, con todas las validaciones baratas ya hechas);
 * `settle` limpia después: el pendiente se borra cuando el abono existe (si
 * falla, se conserva para reintentar) y la copia sin fila (el abono falló, o
 * un reintento idempotente devolvió el original) se borra.
 */
@Injectable()
export class PaymentProofs {
  private readonly logger = new Logger('PaymentProofs');

  constructor(
    private readonly uploads: PaymentProofUploads,
    @Inject(PAYMENT_REPOSITORY) private readonly repo: PaymentRepository,
  ) {}

  /** `null` sin subida; si no, el comprobante comprobado (400/404 si no vale). */
  async complete(
    uploadId: string | null | undefined,
    uploadedById: string | undefined,
  ): Promise<CompletedProof | null> {
    if (!uploadId) return null;
    return this.uploads.complete(uploadId, uploadedById ?? '');
  }

  /**
   * Tras el intento de alta: `created` dice si el abono se registró. Nunca
   * lanza: en la ruta de fallo no puede tapar el error original (revisión L2),
   * y un fallo de limpieza se avisa (sin claves). Si no se puede comprobar en
   * la BD que ninguna fila usa la copia, se CONSERVA (revisión R2).
   */
  async settle(
    proofs: readonly (CompletedProof | null)[],
    created: boolean,
  ): Promise<void> {
    for (const proof of proofs) {
      if (!proof) continue;
      try {
        // El pendiente se borra (esperando) cuando el abono existe: la subida
        // queda consumida y no se puede entregar a otro abono (revisión L1).
        if (created) await this.uploads.discard(proof.pendingKey);
        if (!(await this.repo.proofKeyInUse(proof.attachment.key))) {
          await this.uploads.discard(proof.attachment.key);
        }
      } catch (error) {
        // R2: si la BD no responde no sabemos si el abono se confirmó (un corte
        // tras el COMMIT): la copia se CONSERVA. Una copia huérfana cuesta
        // poco; un comprobante perdido con su fila ya confirmada, no. Solo se
        // borra cuando se sabe que ninguna fila la usa (arriba).
        this.logger.warn(
          `No se pudo limpiar un comprobante; la copia se conserva (requestId=${currentRequestId() ?? '-'}, created=${created}, error=${error instanceof Error ? error.name : 'NonError'})`,
        );
      }
    }
  }
}

export function attachmentOf(
  proof: CompletedProof | null,
): PaymentProofAttachment | null {
  return proof ? proof.attachment : null;
}
