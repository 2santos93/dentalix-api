import { Inject, Injectable } from '@nestjs/common';
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

  /** Tras el intento de alta: `created` dice si el abono se registró. */
  async settle(
    proofs: readonly (CompletedProof | null)[],
    created: boolean,
  ): Promise<void> {
    for (const proof of proofs) {
      if (!proof) continue;
      if (created) void this.uploads.discard(proof.pendingKey);
      if (!(await this.repo.proofKeyInUse(proof.attachment.key))) {
        await this.uploads.discard(proof.attachment.key);
      }
    }
  }
}

export function attachmentOf(
  proof: CompletedProof | null,
): PaymentProofAttachment | null {
  return proof ? proof.attachment : null;
}
