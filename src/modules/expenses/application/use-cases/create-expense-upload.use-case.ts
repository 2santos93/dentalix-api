import { Injectable } from '@nestjs/common';
import {
  ExpenseReceiptUploads,
  type ReceiptUploadRequest,
  type ReceiptUploadTicket,
} from '../expense-receipt-uploads';

@Injectable()
export class CreateExpenseUploadUseCase {
  constructor(private readonly receipts: ExpenseReceiptUploads) {}

  /**
   * Autoriza al navegador a subir UN soporte (PDF/JPG/PNG, 1 B – 20 MB)
   * directamente al almacén. No toca ningún gasto: el `uploadId` se entrega
   * después con el alta (`attachmentUploadId`) o con `POST …/:id/attachment`.
   */
  execute(
    request: ReceiptUploadRequest,
    uploadedById: string,
  ): Promise<ReceiptUploadTicket> {
    return this.receipts.authorize(request, uploadedById);
  }
}
