import { ConflictException } from '@nestjs/common';
import { gate } from '../../../../../test/support/postgres-concurrency';
import { pdfFixture } from '../../../../../test/support/document-fixtures';
import {
  buildExpenseTestKit,
  uploadReceipt,
  ADMIN,
  clock,
} from '../__fixtures__/expense-test-kit';
import { AttachExpenseReceiptUseCase } from './attach-expense-receipt.use-case';
import { CreateExpenseUseCase } from './create-expense.use-case';

describe('soportes compartidos entre intentos (DX-274, I1)', () => {
  it.each([
    ['attach', 'attach'],
    ['attach', 'create'],
    ['create', 'attach'],
    ['create', 'create'],
  ] as const)(
    'el %s pendiente conserva su objeto tras otro %s fallido',
    async (winner, loser) => {
      const kit = buildExpenseTestKit();
      const a = kit.repo.seed();
      const b = kit.repo.seed();
      const uploadId = await uploadReceipt(kit, pdfFixture());
      const waiting = gate();
      const release = gate();
      const realAttach = kit.repo.attach.bind(kit.repo);
      const realCreate = kit.repo.create.bind(kit.repo);
      kit.repo.attach = async (id, attachment) => {
        if (id === b.id)
          throw new ConflictException('gasto anulado durante la copia');
        waiting.open();
        await release.wait;
        return realAttach(id, attachment);
      };
      let created = false;
      kit.repo.create = async (...args) => {
        if (winner !== 'create' || created)
          throw new ConflictException('gasto anulado durante la copia');
        created = true;
        waiting.open();
        await release.wait;
        return realCreate(...args);
      };
      const attach = new AttachExpenseReceiptUseCase(
        kit.repo,
        kit.receipts,
        clock,
      );
      const create = new CreateExpenseUseCase(
        kit.repo,
        kit.resolver,
        kit.receipts,
        kit.whitelist,
        clock,
      );
      const pending = kit.inTenant(() =>
        winner === 'attach'
          ? attach.execute(a.id, uploadId, ADMIN)
          : create.execute(
              {
                category: 'Papelería',
                amount: 10,
                currency: 'USD',
                invoiceDate: '2026-10-22',
                attachmentUploadId: uploadId,
              },
              ADMIN,
            ),
      );
      await waiting.wait;
      try {
        await expect(
          kit.inTenant(() =>
            loser === 'attach'
              ? attach.execute(b.id, uploadId, ADMIN)
              : create.execute(
                  {
                    category: 'Papelería',
                    amount: 10,
                    currency: 'USD',
                    invoiceDate: '2026-10-22',
                    attachmentUploadId: uploadId,
                  },
                  ADMIN,
                ),
          ),
        ).rejects.toThrow('gasto anulado durante la copia');
      } finally {
        release.open();
      }
      const result = await pending;
      const key = kit.repo.expenses.get(result.id)!.attachment!.key;
      expect((await kit.storage.read(key))?.bytes).toEqual(pdfFixture());
      expect(kit.storage.deleted).not.toContain(key);
    },
  );
});
