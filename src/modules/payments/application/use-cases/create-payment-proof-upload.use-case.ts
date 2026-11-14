import { Injectable } from '@nestjs/common';
import {
  PaymentProofUploads,
  type ProofUploadRequest,
  type ProofUploadTicket,
} from '../payment-proof-uploads';

@Injectable()
export class CreatePaymentProofUploadUseCase {
  constructor(private readonly proofs: PaymentProofUploads) {}

  /**
   * Autoriza al navegador a subir UN comprobante (JPG, PNG, WebP o PDF, 1 B –
   * 10 MB) directamente al almacén privado. No toca ningún abono: el
   * `uploadId` se entrega después al registrarlo (`proofUploadId`).
   */
  execute(
    request: ProofUploadRequest,
    uploadedById: string,
  ): Promise<ProofUploadTicket> {
    return this.proofs.authorize(request, uploadedById);
  }
}
