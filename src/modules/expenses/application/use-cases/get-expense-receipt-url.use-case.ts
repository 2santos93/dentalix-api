import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  FILE_STORAGE,
  type FileStoragePort,
} from '../../../../shared/storage/file-storage.port';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { EXPENSE_NOT_FOUND_MESSAGE } from '../../domain/expense-rules';
import {
  EXPENSE_REPOSITORY,
  type ExpenseRepository,
} from '../../domain/ports/expense-repository.port';
import {
  EXPENSE_CLOCK,
  EXPENSE_RECEIPT_URL_TTL,
  type ExpenseClock,
} from '../expense-tokens';

export const NO_RECEIPT_MESSAGE = 'El gasto no tiene soporte.';

export interface ExpenseReceiptUrl {
  url: string;
  expiresAt: string;
  disposition: 'inline' | 'attachment';
}

@Injectable()
export class GetExpenseReceiptUrlUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly repo: ExpenseRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
    private readonly audit: RecordAuditEventUseCase,
    @Inject(EXPENSE_CLOCK) private readonly clock: ExpenseClock,
    @Inject(EXPENSE_RECEIPT_URL_TTL) private readonly ttlSeconds: number,
  ) {}

  /**
   * URL firmada de corta vida para ver (`inline`) o descargar (`attachment`)
   * el soporte. Disposición, nombre y tipo DETECTADO van firmados en la URL.
   * Queda auditada aquí y no con `@Audit`: la acción depende de la
   * disposición (VIEW si se abre en el navegador, EXPORT si se descarga).
   */
  async execute(
    id: string,
    disposition: 'inline' | 'attachment',
    ctx: AuditRequestContext | undefined,
  ): Promise<ExpenseReceiptUrl> {
    const issuedAt = this.clock();
    const expense = await this.repo.findById(id, issuedAt);
    if (!expense) throw new NotFoundException(EXPENSE_NOT_FOUND_MESSAGE);
    if (!expense.attachment) throw new NotFoundException(NO_RECEIPT_MESSAGE);
    const url = await this.storage.getSignedUrl(
      expense.attachment.key,
      this.ttlSeconds,
      {
        disposition,
        filename: expense.attachment.name,
        contentType: expense.attachment.mime,
      },
    );
    if (ctx) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
        action: disposition === 'inline' ? 'VIEW' : 'EXPORT',
        resourceType: 'EXPENSE',
        resourceId: expense.id,
        patient: null,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: {
          reason:
            disposition === 'inline'
              ? 'EXPENSE_RECEIPT_VIEW'
              : 'EXPENSE_RECEIPT_DOWNLOAD',
        },
      });
    }
    return {
      url,
      expiresAt: new Date(
        issuedAt.getTime() + this.ttlSeconds * 1000,
      ).toISOString(),
      disposition,
    };
  }
}
