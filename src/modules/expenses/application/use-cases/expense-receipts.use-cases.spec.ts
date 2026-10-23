import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  heicFixture,
  htmlFake,
  jpegFixture,
  pdfFixture,
  pngFixture,
  pngRenamedAsPdf,
} from '../../../../../test/support/document-fixtures';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  RECEIPT_REJECTED_CODE,
  RECEIPT_TYPE_MESSAGE,
} from '../../domain/expense-receipt';
import {
  ATTACHMENT_ALREADY_MESSAGE,
  EXPENSE_NOT_FOUND_MESSAGE,
  EXPENSE_VOIDED_MESSAGE,
} from '../../domain/expense-rules';
import {
  ADMIN,
  buildExpenseTestKit,
  clock,
  type ExpenseTestKit,
  NOW,
  sha256Of,
  uploadReceipt,
} from '../__fixtures__/expense-test-kit';
import { TENANT_ID, USER_ID } from '../__fixtures__/in-memory-expenses';
import {
  CHECKSUM_MISMATCH_MESSAGE,
  EMPTY_FILE_MESSAGE,
  INVALID_SIZE_MESSAGE,
  SIZE_MISMATCH_MESSAGE,
  UPLOAD_NOT_FOUND_MESSAGE,
} from '../expense-receipt-uploads';
import { AttachExpenseReceiptUseCase } from './attach-expense-receipt.use-case';
import { CreateExpenseUploadUseCase } from './create-expense-upload.use-case';
import {
  GetExpenseReceiptUrlUseCase,
  NO_RECEIPT_MESSAGE,
} from './get-expense-receipt-url.use-case';

const MB = 1024 * 1024;

describe('soporte de un gasto (DX-274)', () => {
  let kit: ExpenseTestKit;
  let upload: CreateExpenseUploadUseCase;
  let attach: AttachExpenseReceiptUseCase;

  beforeEach(() => {
    kit = buildExpenseTestKit();
    upload = new CreateExpenseUploadUseCase(kit.receipts);
    attach = new AttachExpenseReceiptUseCase(kit.repo, kit.receipts, clock);
  });

  const ask = (patch: Record<string, unknown> = {}, bytes = pdfFixture()) =>
    kit.inTenant(() =>
      upload.execute(
        {
          name: 'factura.pdf',
          mimeType: 'application/pdf',
          size: bytes.length,
          sha256: sha256Of(bytes),
          ...patch,
        },
        ADMIN,
      ),
    );

  describe('autorizar la subida', () => {
    it('devuelve el uploadId y el formulario hacia la clave pendiente, con autor y huella firmados', async () => {
      const bytes = pdfFixture();
      const ticket = await ask();
      expect(ticket).toMatchObject({
        target: { method: 'POST', url: 'memory://bucket' },
        maxBytes: 20 * MB,
      });
      const key = `expense-receipts/pending/${TENANT_ID}/${ticket.uploadId}`;
      const policy = kit.storage.directUploads.get(key)!;
      expect(policy.maxBytes).toBe(20 * MB);
      expect(policy.metadata).toMatchObject({
        'uploaded-by': ADMIN,
        'declared-size': String(bytes.length),
        sha256: sha256Of(bytes),
        'file-name': 'factura.pdf',
      });
      expect(policy.sha256Base64).toBe(
        Buffer.from(sha256Of(bytes), 'hex').toString('base64'),
      );
      expect(policy.ttlSeconds).toBe(900);
    });

    it('el nombre con tildes viaja codificado (los metadatos son ASCII)', async () => {
      const ticket = await ask({ name: 'Recibo Peluquería ñ.pdf' });
      const policy = [...kit.storage.directUploads.values()][0];
      expect(policy.metadata['file-name']).toMatch(/^[\x20-\x7e]+$/);
      expect(decodeURIComponent(policy.metadata['file-name'])).toBe(
        'Recibo Peluquería ñ.pdf',
      );
      expect(ticket.uploadId).toBeDefined();
    });

    it.each([
      ['tamaño 0', { size: 0 }, EMPTY_FILE_MESSAGE],
      ['tamaño no entero', { size: 1.5 }, INVALID_SIZE_MESSAGE],
      ['tamaño negativo', { size: -1 }, INVALID_SIZE_MESSAGE],
      [
        'huella corta',
        { sha256: 'abc' },
        'La huella SHA-256 del archivo no es válida.',
      ],
      [
        'HEIC declarado',
        { mimeType: 'image/heic', name: 'f.heic' },
        RECEIPT_TYPE_MESSAGE,
      ],
      [
        'SVG declarado',
        { mimeType: 'image/svg+xml', name: 'f.svg' },
        RECEIPT_TYPE_MESSAGE,
      ],
    ])('rechaza %s', async (_n, patch, message) => {
      await expect(ask(patch)).rejects.toThrow(
        new BadRequestException(message),
      );
      expect(kit.storage.directUploads.size).toBe(0);
    });

    it('más de 20 MB es 413', async () => {
      await expect(ask({ size: 20 * MB + 1 })).rejects.toBeInstanceOf(
        PayloadTooLargeException,
      );
    });
  });

  describe('adjuntar a un gasto existente', () => {
    it('fija el soporte y deja el objeto en su clave definitiva; el pendiente se borra', async () => {
      const e = kit.repo.seed();
      const uploadId = await uploadReceipt(kit, jpegFixture(), {
        name: 'foto.jpg',
        mimeType: 'image/jpeg',
      });
      const out = await kit.inTenant(() =>
        attach.execute(e.id, uploadId, ADMIN),
      );
      expect(out.attachment).toMatchObject({
        name: 'foto.jpg',
        mimeType: 'image/jpeg',
      });
      const key = kit.repo.expenses.get(e.id)!.attachment!.key;
      expect(key).toMatch(/\.jpg$/);
      expect(kit.storage.files.get(key)?.contentType).toBe('image/jpeg');
      expect(
        [...kit.storage.files.keys()].some((k) => k.includes('/pending/')),
      ).toBe(false);
    });

    it('acepta PDF, JPG y PNG; rechaza HEIC aunque se declare como JPG, y borra el objeto', async () => {
      for (const [bytes, declared] of [
        [pdfFixture(), { name: 'a.pdf', mimeType: 'application/pdf' }],
        [pngFixture(), { name: 'a.png', mimeType: 'image/png' }],
      ] as const) {
        const e = kit.repo.seed();
        const id = await uploadReceipt(kit, bytes, declared);
        await expect(
          kit.inTenant(() => attach.execute(e.id, id, ADMIN)),
        ).resolves.toBeDefined();
      }
      const e = kit.repo.seed();
      const heic = await uploadReceipt(kit, heicFixture(), {
        name: 'a.jpg',
        mimeType: 'image/jpeg',
      });
      const before = kit.storage.files.size;
      await expect(
        kit.inTenant(() => attach.execute(e.id, heic, ADMIN)),
      ).rejects.toMatchObject({
        response: {
          code: RECEIPT_REJECTED_CODE,
          message: RECEIPT_TYPE_MESSAGE,
        },
      });
      expect(kit.storage.files.size).toBe(before - 1);
      expect(kit.repo.expenses.get(e.id)!.attachment).toBeNull();
    });

    it('HTML renombrado .pdf: 400 con el mensaje de tipo y el pendiente desaparece', async () => {
      const e = kit.repo.seed();
      const id = await uploadReceipt(kit, htmlFake(), {
        name: 'factura.pdf',
        mimeType: 'application/pdf',
      });
      await expect(
        kit.inTenant(() => attach.execute(e.id, id, ADMIN)),
      ).rejects.toMatchObject({
        response: { message: RECEIPT_TYPE_MESSAGE },
      });
      expect(kit.storage.files.size).toBe(0);
    });

    it('un PNG con nombre .pdf no cuadra con su tipo (400) y se borra', async () => {
      const e = kit.repo.seed();
      const { bytes, originalName } = pngRenamedAsPdf();
      const id = await uploadReceipt(kit, bytes, {
        name: originalName,
        mimeType: 'application/pdf',
      });
      await expect(
        kit.inTenant(() => attach.execute(e.id, id, ADMIN)),
      ).rejects.toMatchObject({ status: 400 });
      expect(kit.storage.files.size).toBe(0);
    });

    it('rechaza (y borra) un objeto de tamaño o huella distintos de lo declarado', async () => {
      const e = kit.repo.seed();
      const id1 = await uploadReceipt(kit, pdfFixture());
      const key1 = [...kit.storage.files.keys()][0];
      const file = kit.storage.files.get(key1)!;
      kit.storage.simulateDirectUpload(
        key1,
        Buffer.concat([file.bytes, Buffer.from('x')]),
        {
          metadata: file.metadata,
        },
      );
      await expect(
        kit.inTenant(() => attach.execute(e.id, id1, ADMIN)),
      ).rejects.toThrow(new BadRequestException(SIZE_MISMATCH_MESSAGE));

      const id2 = await uploadReceipt(kit, pdfFixture());
      const key2 = [...kit.storage.files.keys()].find((k) => k.endsWith(id2))!;
      const f2 = kit.storage.files.get(key2)!;
      kit.storage.simulateDirectUpload(key2, f2.bytes, {
        metadata: f2.metadata,
        sha256Base64: Buffer.alloc(32, 1).toString('base64'),
      });
      await expect(
        kit.inTenant(() => attach.execute(e.id, id2, ADMIN)),
      ).rejects.toThrow(new BadRequestException(CHECKSUM_MISMATCH_MESSAGE));
      expect(kit.storage.files.size).toBe(0);
    });

    it('404 si la subida no existe o es de otro usuario, sin tocarla', async () => {
      const e = kit.repo.seed();
      await expect(
        kit.inTenant(() =>
          attach.execute(e.id, '9b2f9a6e-3f1c-4d2e-8a55-0d3f6a1b7c10', ADMIN),
        ),
      ).rejects.toThrow(new NotFoundException(UPLOAD_NOT_FOUND_MESSAGE));
      const id = await uploadReceipt(kit, pdfFixture(), undefined, 'otro');
      await expect(
        kit.inTenant(() => attach.execute(e.id, id, ADMIN)),
      ).rejects.toThrow(UPLOAD_NOT_FOUND_MESSAGE);
      expect(kit.storage.files.size).toBe(1);
    });

    it('solo una vez: con soporte ya puesto es 409 y no consume la subida', async () => {
      const e = kit.repo.seed();
      const first = await uploadReceipt(kit, pdfFixture());
      await kit.inTenant(() => attach.execute(e.id, first, ADMIN));
      const second = await uploadReceipt(kit, pngFixture(), {
        name: 'b.png',
        mimeType: 'image/png',
      });
      await expect(
        kit.inTenant(() => attach.execute(e.id, second, ADMIN)),
      ).rejects.toThrow(new ConflictException(ATTACHMENT_ALREADY_MESSAGE));
      expect(
        [...kit.storage.files.keys()].some((k) => k.endsWith(second)),
      ).toBe(true);
    });

    it('un gasto anulado o inexistente no recibe soporte', async () => {
      const id = await uploadReceipt(kit, pdfFixture());
      const voided = kit.repo.seed({
        voidedAt: new Date(),
        voidedById: USER_ID,
        voidReason: 'duplicado',
      });
      await expect(
        kit.inTenant(() => attach.execute(voided.id, id, ADMIN)),
      ).rejects.toThrow(new ConflictException(EXPENSE_VOIDED_MESSAGE));
      await expect(
        kit.inTenant(() => attach.execute('nope', id, ADMIN)),
      ).rejects.toThrow(new NotFoundException(EXPENSE_NOT_FOUND_MESSAGE));
    });

    it('si otra petición se adelantó, el objeto copiado sin fila se borra', async () => {
      const e = kit.repo.seed();
      const id = await uploadReceipt(kit, pdfFixture());
      // La otra petición gana entre la comprobación y la escritura.
      const realAttach = kit.repo.attach.bind(kit.repo);
      kit.repo.attach = (...args) => {
        kit.repo.expenses.get(e.id)!.attachment = {
          key: 'expense-receipts/otro/x.pdf',
          mime: 'application/pdf',
          size: 1,
          sha256: 'aa'.repeat(32),
          name: 'otro.pdf',
        };
        return realAttach(...args);
      };
      await expect(
        kit.inTenant(() => attach.execute(e.id, id, ADMIN)),
      ).rejects.toThrow(ATTACHMENT_ALREADY_MESSAGE);
      expect(
        [...kit.storage.files.keys()].filter((k) => !k.includes('/pending/')),
      ).toEqual([]);
    });

    it('el vacío es 400 (aunque el almacén lo haya aceptado)', async () => {
      const e = kit.repo.seed();
      const ticket = await ask({ size: 1, sha256: sha256Of(Buffer.alloc(0)) });
      const key = [...kit.storage.directUploads.keys()][0];
      kit.storage.simulateDirectUpload(key, Buffer.alloc(0));
      await expect(
        kit.inTenant(() => attach.execute(e.id, ticket.uploadId, ADMIN)),
      ).rejects.toMatchObject({
        response: { message: EMPTY_FILE_MESSAGE },
      });
    });
  });

  describe('URL firmada', () => {
    const events: AuditEventDraft[] = [];
    const ctx: AuditRequestContext = {
      tenantId: TENANT_ID,
      locationId: null,
      actor: { userId: ADMIN, role: 'ADMIN' },
      requestId: 'req-1',
      ip: '10.0.0.1',
      userAgent: 'jest',
    };
    let url: GetExpenseReceiptUrlUseCase;

    beforeEach(() => {
      events.length = 0;
      const audit = {
        record: (draft: AuditEventDraft) => {
          events.push(draft);
          return Promise.resolve();
        },
      } as unknown as RecordAuditEventUseCase;
      url = new GetExpenseReceiptUrlUseCase(
        kit.repo,
        kit.storage,
        audit,
        clock,
        300,
      );
    });

    const withReceipt = () =>
      kit.repo.seed({
        attachment: {
          key: `expense-receipts/${TENANT_ID}/u-aaaa.pdf`,
          mime: 'application/pdf',
          size: 10,
          sha256: 'ab'.repeat(32),
          name: 'factura luz.pdf',
        },
      });

    it('inline: URL de 300 s con nombre y tipo firmados, y auditada como VIEW', async () => {
      const e = withReceipt();
      const out = await kit.inTenant(() => url.execute(e.id, 'inline', ctx));
      expect(out.disposition).toBe('inline');
      expect(out.expiresAt).toBe(
        new Date(NOW.getTime() + 300_000).toISOString(),
      );
      const parsed = new URL(out.url.replace('memory://', 'http://x/'));
      expect(parsed.searchParams.get('ttl')).toBe('300');
      expect(parsed.searchParams.get('disposition')).toBe('inline');
      expect(parsed.searchParams.get('filename')).toBe('factura luz.pdf');
      expect(parsed.searchParams.get('type')).toBe('application/pdf');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'VIEW',
        resourceType: 'EXPENSE',
        resourceId: e.id,
        patient: null,
        tenantId: TENANT_ID,
        metadata: { reason: 'EXPENSE_RECEIPT_VIEW' },
      });
    });

    it('attachment: descarga auditada como EXPORT', async () => {
      const e = withReceipt();
      const out = await kit.inTenant(() =>
        url.execute(e.id, 'attachment', ctx),
      );
      expect(out.url).toContain('disposition=attachment');
      expect(events[0]).toMatchObject({
        action: 'EXPORT',
        metadata: { reason: 'EXPENSE_RECEIPT_DOWNLOAD' },
      });
    });

    it('la auditoría no lleva el nombre del archivo, el proveedor ni la descripción', async () => {
      const e = kit.repo.seed({
        supplier: 'Proveedor secreto',
        description: 'Descripción secreta',
        attachment: withReceipt().attachment,
      });
      await kit.inTenant(() => url.execute(e.id, 'inline', ctx));
      const text = JSON.stringify(events[0]);
      expect(text).not.toContain('secret');
      expect(text).not.toContain('factura');
    });

    it('404 si no hay gasto o no tiene soporte, y no audita', async () => {
      const bare = kit.repo.seed();
      await expect(
        kit.inTenant(() => url.execute(bare.id, 'inline', ctx)),
      ).rejects.toThrow(new NotFoundException(NO_RECEIPT_MESSAGE));
      await expect(
        kit.inTenant(() => url.execute('nope', 'inline', ctx)),
      ).rejects.toThrow(EXPENSE_NOT_FOUND_MESSAGE);
      expect(events).toHaveLength(0);
    });
  });
});
