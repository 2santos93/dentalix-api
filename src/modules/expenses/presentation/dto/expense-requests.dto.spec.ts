import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AMOUNT_MESSAGE,
  CATEGORY_INVALID_MESSAGE,
  INVOICE_DATE_INVALID_MESSAGE,
} from '../../domain/expense-rules';
import {
  AddExpensePaymentDto,
  AttachExpenseReceiptDto,
  CreateExpenseCategoryDto,
  CreateExpenseDto,
  CreateExpenseUploadDto,
  ListExpensesQueryDto,
  ReceiptUrlQueryDto,
  UpdateExpenseDto,
  VoidExpenseDto,
} from './expense-requests.dto';

async function messages(cls: new () => object, plain: object) {
  const errors = await validate(plainToInstance(cls, plain), {
    whitelist: true,
  });
  const flat = (list: typeof errors): string[] =>
    list.flatMap((e) => [
      ...Object.values(e.constraints ?? {}),
      ...flat(e.children ?? []),
    ]);
  return flat(errors);
}

const valid = {
  category: 'Papelería',
  amount: 120000.5,
  currency: 'cop',
  invoiceDate: '2026-10-20',
};

describe('DTOs de gastos (DX-274)', () => {
  describe('alta', () => {
    it('acepta el mínimo, y el opcional completo, normalizando la moneda', async () => {
      expect(await messages(CreateExpenseDto, valid)).toEqual([]);
      expect(
        await messages(CreateExpenseDto, {
          ...valid,
          locationId: '9b2f9a6e-3f1c-4d2e-8a55-0d3f6a1b7c10',
          supplier: null,
          description: 'x',
          dueDate: '2026-11-01',
          payment: { amount: 1000, method: 'CASH', paidOn: '2026-10-20' },
          attachmentUploadId: '9b2f9a6e-3f1c-4d2e-8a55-0d3f6a1b7c10',
        }),
      ).toEqual([]);
      expect(plainToInstance(CreateExpenseDto, valid).currency).toBe('COP');
    });

    it('no tiene fromCashSession: lo desconocido se descarta', async () => {
      const dto = plainToInstance(CreateExpenseDto, {
        ...valid,
        payment: { amount: 1, method: 'CASH', fromCashSession: true },
      });
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: false,
      });
      expect(errors).toEqual([]);
      expect(dto.payment).not.toHaveProperty('fromCashSession');
    });

    it.each([0, -5, 10.123, 1e12, '10', null, undefined])(
      'rechaza el importe %p con el mensaje en español',
      async (amount) => {
        expect(
          await messages(CreateExpenseDto, { ...valid, amount }),
        ).toContain(AMOUNT_MESSAGE);
      },
    );

    it('rechaza categoría y fecha de factura ausentes o de otro tipo', async () => {
      expect(
        await messages(CreateExpenseDto, { ...valid, category: undefined }),
      ).toContain(CATEGORY_INVALID_MESSAGE);
      expect(
        await messages(CreateExpenseDto, { ...valid, invoiceDate: 20261020 }),
      ).toContain(INVOICE_DATE_INVALID_MESSAGE);
    });

    it('rechaza una moneda inexistente, un medio fuera del enum y un pago sin importe', async () => {
      expect(
        await messages(CreateExpenseDto, { ...valid, currency: 'ZZZZ' }),
      ).toEqual(['La moneda no es válida.']);
      expect(
        await messages(CreateExpenseDto, {
          ...valid,
          payment: { amount: 1, method: 'BITCOIN' },
        }),
      ).toEqual([expect.stringMatching(/^El medio de pago debe ser uno de/)]);
      expect(
        await messages(CreateExpenseDto, {
          ...valid,
          payment: { method: 'CASH' },
        }),
      ).toContain(AMOUNT_MESSAGE);
    });

    it('rechaza una sede o una subida que no son uuid', async () => {
      expect(
        await messages(CreateExpenseDto, { ...valid, locationId: 'x' }),
      ).toEqual(['La sede no es válida.']);
      expect(
        await messages(CreateExpenseDto, { ...valid, attachmentUploadId: 'x' }),
      ).toEqual(['La subida del soporte no es válida.']);
    });
  });

  describe('edición', () => {
    it('admite campos sueltos y null en proveedor, descripción y vencimiento', async () => {
      expect(await messages(UpdateExpenseDto, {})).toEqual([]);
      expect(
        await messages(UpdateExpenseDto, {
          supplier: null,
          description: null,
          dueDate: null,
          amount: 5,
        }),
      ).toEqual([]);
    });

    it.each(['category', 'invoiceDate', 'amount', 'currency', 'locationId'])(
      'rechaza %s: null (columna NOT NULL)',
      async (key) => {
        expect(
          (await messages(UpdateExpenseDto, { [key]: null })).length,
        ).toBeGreaterThan(0);
      },
    );
  });

  describe('pagos y anulación', () => {
    it('el pago exige importe y medio', async () => {
      expect(
        await messages(AddExpensePaymentDto, { amount: 5, method: 'CARD' }),
      ).toEqual([]);
      const out = await messages(AddExpensePaymentDto, {});
      expect(out).toContain(AMOUNT_MESSAGE);
      expect(out).toContainEqual(
        expect.stringMatching(/^El medio de pago debe ser uno de/),
      );
    });

    it('el motivo es texto', async () => {
      expect(await messages(VoidExpenseDto, { reason: 'Duplicado' })).toEqual(
        [],
      );
      expect((await messages(VoidExpenseDto, { reason: 5 })).length).toBe(1);
    });
  });

  describe('lista', () => {
    const q = (plain: object) => plainToInstance(ListExpensesQueryDto, plain);

    it('convierte página, tamaño y «vencidos» desde la query', async () => {
      const dto = q({
        page: '2',
        pageSize: '25',
        overdue: 'true',
        status: 'OPEN',
      });
      expect(dto).toMatchObject({ page: 2, pageSize: 25, overdue: true });
      expect(await validate(dto)).toEqual([]);
      expect(q({ overdue: 'false' }).overdue).toBe(false);
    });

    it.each([
      { page: '0' },
      { pageSize: '101' },
      { pageSize: 'x' },
      { status: 'OTRO' },
      { overdue: 'tal vez' },
      { locationId: 'x' },
    ])('rechaza %j', async (plain) => {
      expect((await validate(q(plain))).length).toBeGreaterThan(0);
    });
  });

  describe('soporte y categorías', () => {
    it('upload-url pide tamaño entero y huella; nombre y tipo son opcionales', async () => {
      expect(
        await messages(CreateExpenseUploadDto, {
          size: 10,
          sha256: 'a'.repeat(64),
        }),
      ).toEqual([]);
      expect(
        (await messages(CreateExpenseUploadDto, { size: 1.5 })).length,
      ).toBe(2);
    });

    it('adjuntar pide un uploadId uuid', async () => {
      expect(
        await messages(AttachExpenseReceiptDto, { uploadId: 'x' }),
      ).toEqual(['La subida del soporte no es válida.']);
    });

    it('la disposición es inline o attachment', async () => {
      expect(await messages(ReceiptUrlQueryDto, {})).toEqual([]);
      expect(
        await messages(ReceiptUrlQueryDto, { disposition: 'attachment' }),
      ).toEqual([]);
      expect(
        (await messages(ReceiptUrlQueryDto, { disposition: 'x' })).length,
      ).toBe(1);
    });

    it('el nombre de una categoría es texto', async () => {
      expect(
        await messages(CreateExpenseCategoryDto, { name: 'Seguros' }),
      ).toEqual([]);
      expect((await messages(CreateExpenseCategoryDto, {})).length).toBe(1);
    });
  });
});
