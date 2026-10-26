import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ATTACHMENT_ALREADY_MESSAGE,
  EXPENSE_NOT_FOUND_MESSAGE,
  EXPENSE_VOIDED_MESSAGE,
} from '../../domain/expense-rules';
import {
  EXPENSE_REPOSITORY,
  type ExpenseRepository,
} from '../../domain/ports/expense-repository.port';
import { ExpenseReceiptUploads } from '../expense-receipt-uploads';
import { EXPENSE_CLOCK, type ExpenseClock } from '../expense-tokens';
import { type ExpenseDetailView, detailViewOf } from '../expense-view';
import { guarded } from '../guarded';

@Injectable()
export class AttachExpenseReceiptUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly repo: ExpenseRepository,
    private readonly receipts: ExpenseReceiptUploads,
    @Inject(EXPENSE_CLOCK) private readonly clock: ExpenseClock,
  ) {}

  /**
   * Fija el soporte de un gasto que aún no lo tiene (una vez, no se cambia).
   * Las comprobaciones baratas van ANTES de tocar el objeto subido, para no
   * gastar (ni borrar) un soporte que no se puede usar.
   */
  async execute(
    id: string,
    uploadId: string,
    uploadedById: string,
  ): Promise<ExpenseDetailView> {
    const now = this.clock();
    const current = await this.repo.findById(id, now);
    if (!current) throw new NotFoundException(EXPENSE_NOT_FOUND_MESSAGE);
    if (current.voidedAt) throw new ConflictException(EXPENSE_VOIDED_MESSAGE);
    if (current.attachment) {
      throw new ConflictException(ATTACHMENT_ALREADY_MESSAGE);
    }

    const receipt = await this.receipts.complete(uploadId, uploadedById);
    let detail;
    try {
      detail = await guarded(() =>
        this.repo.attach(id, receipt.attachment, now),
      );
    } catch (error) {
      // Otra petición se adelantó: el objeto copiado no tiene fila.
      if (!(await this.repo.attachmentKeyInUse(receipt.attachment.key))) {
        await this.receipts.discard(receipt.attachment.key);
      }
      throw error;
    }
    void this.receipts.discard(receipt.pendingKey);
    return detailViewOf(this.repo, detail);
  }
}
