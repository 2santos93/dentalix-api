import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { AttachExpenseReceiptUseCase } from '../src/modules/expenses/application/use-cases/attach-expense-receipt.use-case';
import { CreateExpenseUseCase } from '../src/modules/expenses/application/use-cases/create-expense.use-case';
import { ExpenseCategoryResolver } from '../src/modules/expenses/application/expense-category-resolver';
import { ExpenseReceiptUploads } from '../src/modules/expenses/application/expense-receipt-uploads';
import { PrismaExpenseRepository } from '../src/modules/expenses/infrastructure/repositories/prisma-expense.repository';
import { PrismaExpenseCategoryRepository } from '../src/modules/expenses/infrastructure/repositories/prisma-expense-category.repository';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  S3FileStorage,
  createS3Client,
} from '../src/shared/storage/s3-file-storage';
import { describeWithMinio, ensureBucket } from './support/minio';
import { pdfFixture } from './support/document-fixtures';
import {
  gate,
  settle,
  transactionId,
  waitForTransactionWaiters,
} from './support/postgres-concurrency';
import { INVOICE_DATE_FUTURE_MESSAGE } from '../src/modules/expenses/domain/expense-rules';

// Barreras explícitas + transacciones reales y S3: el objeto de A ya está
// copiado y su referencia aún sin COMMIT cuando falla y limpia B.
describeWithMinio(
  'soporte pendiente de COMMIT frente a cleanup ajeno (DX-274, I1)',
  (cfg) => {
    const raw = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: process.env.DIRECT_URL } },
    });
    const context = new TenantContextService();
    const prisma = new PrismaService(context);
    const repo = new PrismaExpenseRepository(prisma, context);
    const now = new Date('2026-10-26T01:00:00Z');
    const clock = () => now;
    let tenantId: string;
    let userId: string;
    let locationId: string;
    let storage: S3FileStorage;
    let receipts: ExpenseReceiptUploads;
    const keys = new Set<string>();
    const inTenant = <T>(fn: () => Promise<T>) => context.run(tenantId, fn);

    beforeAll(async () => {
      await prisma.onModuleInit();
      await ensureBucket(cfg);
      storage = new S3FileStorage(createS3Client(cfg), cfg);
      const copy = storage.copyVersion.bind(storage);
      storage.copyVersion = (...args) => {
        keys.add(args[1]);
        return copy(...args);
      };
      receipts = new ExpenseReceiptUploads(storage, context, 900);
      tenantId = (
        await raw.tenant.create({
          data: { name: 'I1 receipt', subdomain: `receipt-${randomUUID()}` },
        })
      ).id;
      userId = (
        await raw.user.create({
          data: {
            email: `receipt-${randomUUID()}@example.com`,
            fullName: 'Receipt',
            passwordHash: 'fixture',
          },
        })
      ).id;
      locationId = (
        await raw.location.create({
          data: { tenantId, name: 'Tokyo', country: 'CO' },
        })
      ).id;
      await raw.locationSchedule.create({
        data: { tenantId, locationId, timezone: 'Asia/Tokyo' },
      });
    });

    afterAll(async () => {
      for (const key of keys) await storage.delete(key);
      if (tenantId) {
        const where = { tenantId };
        await raw.expense.deleteMany({ where });
        await raw.locationSchedule.deleteMany({ where });
        await raw.location.deleteMany({ where });
        await raw.tenant.delete({ where: { id: tenantId } });
      }
      if (userId) await raw.user.delete({ where: { id: userId } });
      await raw.$disconnect();
      await prisma.onModuleDestroy();
    });

    const newExpense = () =>
      raw.expense.create({
        data: {
          tenantId,
          locationId,
          createdById: userId,
          category: 'Papelería',
          amount: 10,
          currency: 'USD',
          invoiceDate: new Date('2026-10-25T00:00:00Z'),
        },
      });

    it.each(['attach', 'create'] as const)(
      'un %s ganador conserva referencia y bytes después del cleanup de B antes de COMMIT',
      async (operation) => {
        const a = await newExpense();
        const b = await newExpense();
        const bytes = pdfFixture();
        const ticket = await inTenant(() =>
          receipts.authorize(
            {
              name: 'receipt.pdf',
              mimeType: 'application/pdf',
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
            userId,
          ),
        );
        keys.add(ticket.target.fields.key);
        const form = new FormData();
        for (const [name, value] of Object.entries(ticket.target.fields))
          form.append(name, value);
        form.append('file', new Blob([new Uint8Array(bytes)]));
        expect(
          (await fetch(ticket.target.url, { method: 'POST', body: form }))
            .status,
        ).toBe(204);

        const attached = gate();
        const release = gate();
        const delaying = {
          runWithTenant: <T>(
            fn: (tx: Prisma.TransactionClient) => Promise<T>,
          ) =>
            prisma.runWithTenant(
              async (tx) => {
                const result = await fn(tx);
                const candidate = result as {
                  attachment?: { key: string } | null;
                  detail?: { attachment?: { key: string } | null };
                } | null;
                const pendingKey =
                  candidate?.attachment?.key ??
                  candidate?.detail?.attachment?.key;
                if (pendingKey && !held) {
                  held = true;
                  winnerKey = pendingKey;
                  attached.open();
                  await release.wait;
                }
                return result;
              },
              { timeout: 15_000 },
            ),
        } as unknown as PrismaService;
        let held = false;
        let winnerKey = '';
        const winnerRepo = new PrismaExpenseRepository(delaying, context);
        const winner =
          operation === 'attach'
            ? inTenant(() =>
                new AttachExpenseReceiptUseCase(
                  winnerRepo,
                  receipts,
                  clock,
                ).execute(a.id, ticket.uploadId, userId),
              )
            : inTenant(() =>
                new CreateExpenseUseCase(
                  winnerRepo,
                  new ExpenseCategoryResolver(
                    new PrismaExpenseCategoryRepository(prisma, context),
                  ),
                  receipts,
                  { has: () => Promise.resolve(true) },
                  clock,
                ).execute(
                  {
                    category: 'Papelería',
                    amount: 10,
                    currency: 'USD',
                    invoiceDate: '2026-10-25',
                    locationId,
                    attachmentUploadId: ticket.uploadId,
                  },
                  userId,
                ),
              );
        const settled = settle(winner);
        await attached.wait;
        try {
          expect(await inTenant(() => repo.attachmentKeyInUse(winnerKey))).toBe(
            false,
          );
          // B fue leído sin anular por el caso de uso, pero se anula justo cuando
          // su repositorio toma la escritura, después de validar/copiar el upload.
          const loserRepo = new PrismaExpenseRepository(prisma, context);
          const realAttach = loserRepo.attach.bind(loserRepo);
          loserRepo.attach = async (...args) => {
            await raw.expense.update({
              where: { id: b.id },
              data: {
                voidedAt: now,
                voidedById: userId,
                voidReason: 'Duplicado',
              },
            });
            return realAttach(...args);
          };
          await expect(
            inTenant(() =>
              new AttachExpenseReceiptUseCase(
                loserRepo,
                receipts,
                clock,
              ).execute(b.id, ticket.uploadId, userId),
            ),
          ).rejects.toMatchObject({ status: 409 });
        } finally {
          release.open();
        }
        const result = await settled;
        expect(result.status).toBe('fulfilled');
        const stored = await raw.expense.findFirstOrThrow({
          where: { tenantId, attachmentKey: winnerKey },
        });
        expect(stored.attachmentSha256).toBe(
          createHash('sha256').update(bytes).digest('hex'),
        );
        const response = await fetch(await storage.getSignedUrl(winnerKey, 60));
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      },
    );
    describe('fecha final al mover un gasto (M1)', () => {
      let previousDayLocation: string;
      beforeAll(async () => {
        previousDayLocation = (
          await raw.location.create({
            data: { tenantId, name: 'Pacific', country: 'CO' },
          })
        ).id;
        await raw.locationSchedule.create({
          data: {
            tenantId,
            locationId: previousDayLocation,
            timezone: 'America/Los_Angeles',
          },
        });
      });
      it('PATCH solo sede no deja en el destino una factura futura, y conserva el gasto', async () => {
        const expense = await newExpense();
        await raw.expense.update({
          where: { id: expense.id },
          data: { invoiceDate: new Date('2026-10-26T00:00:00Z') },
        });
        await expect(
          inTenant(() =>
            repo.update(expense.id, { locationId: previousDayLocation }, now),
          ),
        ).rejects.toThrow(INVOICE_DATE_FUTURE_MESSAGE);
        expect(
          await raw.expense.findUniqueOrThrow({ where: { id: expense.id } }),
        ).toMatchObject({
          locationId,
          invoiceDate: new Date('2026-10-26T00:00:00Z'),
        });
      });
      it('revalida la factura concurrente después de tomar el bloqueo, sin usar la lectura previa', async () => {
        const expense = await newExpense();
        const xid = gate<string>();
        const release = gate();
        const writer = settle(
          raw.$transaction(
            async (tx) => {
              await tx.expense.update({
                where: { id: expense.id },
                data: { invoiceDate: new Date('2026-10-26T00:00:00Z') },
              });
              xid.open(await transactionId(tx));
              await release.wait;
            },
            { timeout: 15_000 },
          ),
        );
        const updating = await xid.wait;
        const moved = settle(
          inTenant(() =>
            repo.update(expense.id, { locationId: previousDayLocation }, now),
          ),
        );
        try {
          await waitForTransactionWaiters(raw, updating);
        } finally {
          release.open();
        }
        expect((await writer).status).toBe('fulfilled');
        const result = await moved;
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected')
          expect(result.reason).toMatchObject({
            message: INVOICE_DATE_FUTURE_MESSAGE,
          });
        expect(
          await raw.expense.findUniqueOrThrow({ where: { id: expense.id } }),
        ).toMatchObject({ locationId });
      });
    });
  },
);
