import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  jpegFixture,
  pdfFixture,
  htmlFake,
} from '../../../../../test/support/document-fixtures';
import { RECEIPT_TYPE_MESSAGE } from '../../domain/expense-receipt';
import {
  AMOUNT_MESSAGE,
  EXPENSE_CASH_ALWAYS_IN_SESSION_MESSAGE,
  FROM_CASH_METHOD_MESSAGE,
  FROM_CASH_PAID_ON_MESSAGE,
  OPEN_CASH_SESSION_REQUIRED_MESSAGE,
  CATEGORY_INVALID_MESSAGE,
  DUE_BEFORE_INVOICE_MESSAGE,
  IDEMPOTENCY_KEY_INVALID_MESSAGE,
  IDEMPOTENCY_KEY_REUSED_MESSAGE,
  UNKNOWN_CURRENCY_MESSAGE,
  INVOICE_DATE_FUTURE_MESSAGE,
  LOCATION_INVALID_MESSAGE,
  PAID_ON_FUTURE_MESSAGE,
  SUPPLIER_MESSAGE,
} from '../../domain/expense-rules';
import {
  ADMIN,
  buildExpenseTestKit,
  clock,
  type ExpenseTestKit,
  FakeCashLink,
  uploadReceipt,
} from '../__fixtures__/expense-test-kit';
import type { IdempotencySignals } from '../idempotency-guard';
import {
  LOCATION_ID,
  OTHER_LOCATION_ID,
} from '../__fixtures__/in-memory-expenses';
import {
  type CreateExpenseInput,
  CreateExpenseUseCase,
  type InitialPaymentInput,
} from './create-expense.use-case';

const KEY = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const input = (
  patch: Partial<CreateExpenseInput> = {},
): CreateExpenseInput => ({
  category: 'Papelería',
  supplier: 'Papelería Luna',
  amount: 120000,
  currency: 'COP',
  invoiceDate: '2026-10-20',
  ...patch,
});

describe('alta de un gasto (DX-274)', () => {
  let kit: ExpenseTestKit;
  let create: CreateExpenseUseCase;
  const run = (body: CreateExpenseInput, key?: string, user = ADMIN) =>
    kit.inTenant(() => create.execute(body, user, key));

  beforeEach(() => {
    kit = buildExpenseTestKit();
    kit.categories.seed('Seguros');
    create = new CreateExpenseUseCase(
      kit.repo,
      kit.resolver,
      kit.receipts,
      kit.whitelist,
      clock,
    );
  });

  it('crea el gasto en la sede resuelta, PENDING y sin pagos', async () => {
    const out = await run(
      input({ dueDate: '2026-11-20', description: ' Resmas ' }),
    );
    expect(out).toMatchObject({
      locationId: LOCATION_ID,
      category: 'Papelería',
      supplier: 'Papelería Luna',
      description: 'Resmas',
      amount: 120000,
      currency: 'COP',
      invoiceDate: '2026-10-20',
      dueDate: '2026-11-20',
      paidAmount: 0,
      pendingAmount: 120000,
      status: 'PENDING',
      overdue: false,
      attachment: null,
      payments: [],
      createdById: ADMIN,
    });
    expect(kit.repo.expenses.size).toBe(1);
  });

  it('normaliza el proveedor y la moneda, y guarda la categoría con su grafía canónica', async () => {
    const out = await run(
      input({
        category: ' insumos CLINICOS ',
        supplier: '  Dental   Pro  ',
        currency: 'usd',
      }),
    );
    expect(out).toMatchObject({
      category: 'Insumos clínicos',
      supplier: 'Dental Pro',
      currency: 'USD',
    });
  });

  it('acepta una categoría propia activa y rechaza una desconocida o retirada', async () => {
    expect((await run(input({ category: 'seguros' }))).category).toBe(
      'Seguros',
    );
    await expect(run(input({ category: 'Inventada' }))).rejects.toThrow(
      new BadRequestException(CATEGORY_INVALID_MESSAGE),
    );
    const retired = kit.categories.seed('Vieja');
    await kit.categories.retire(retired.id);
    await expect(run(input({ category: 'Vieja' }))).rejects.toThrow(
      CATEGORY_INVALID_MESSAGE,
    );
    expect(kit.repo.expenses.size).toBe(1);
  });

  it('valida importe, moneda, proveedor y fechas sin crear nada', async () => {
    await expect(run(input({ amount: 0 }))).rejects.toThrow(AMOUNT_MESSAGE);
    await expect(run(input({ amount: 10.123 }))).rejects.toThrow(
      AMOUNT_MESSAGE,
    );
    await expect(run(input({ currency: 'ZZZ' }))).rejects.toThrow(
      UNKNOWN_CURRENCY_MESSAGE,
    );
    await expect(run(input({ supplier: 'x'.repeat(201) }))).rejects.toThrow(
      SUPPLIER_MESSAGE,
    );
    await expect(run(input({ invoiceDate: '2026-10-24' }))).rejects.toThrow(
      INVOICE_DATE_FUTURE_MESSAGE,
    );
    await expect(
      run(input({ invoiceDate: '2026-10-20', dueDate: '2026-10-19' })),
    ).rejects.toThrow(DUE_BEFORE_INVOICE_MESSAGE);
    expect(kit.repo.expenses.size).toBe(0);
  });

  it('«hoy» es el de la sede: una factura de mañana en UTC puede ser de hoy allí', async () => {
    kit.repo.today = '2026-10-24';
    expect((await run(input({ invoiceDate: '2026-10-24' }))).invoiceDate).toBe(
      '2026-10-24',
    );
  });

  describe('sede', () => {
    it('usa la del cuerpo si se permite', async () => {
      const out = await run(input({ locationId: OTHER_LOCATION_ID }));
      expect(out.locationId).toBe(OTHER_LOCATION_ID);
    });

    it('rechaza una sede inválida (400) y deja pasar el 403 de una no permitida', async () => {
      kit.repo.invalidLocations.add(OTHER_LOCATION_ID);
      await expect(
        run(input({ locationId: OTHER_LOCATION_ID })),
      ).rejects.toThrow(new BadRequestException(LOCATION_INVALID_MESSAGE));
      kit.repo.resolveLocation = () => {
        throw new ForbiddenException('LOCATION_NOT_ALLOWED');
      };
      await expect(
        run(input({ locationId: OTHER_LOCATION_ID })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('pago inicial', () => {
    it('queda PARTIAL con un pago menor y PAID con el total, en la misma operación', async () => {
      const partial = await run(
        input({ payment: { amount: 20000, method: 'TRANSFER' } }),
      );
      expect(partial).toMatchObject({ status: 'PARTIAL', paidAmount: 20000 });
      expect(partial.payments).toHaveLength(1);
      expect(partial.payments[0]).toMatchObject({
        method: 'TRANSFER',
        paidOn: '2026-10-23',
        cashSessionId: null,
        createdById: ADMIN,
      });

      const paid = await run(
        input({
          payment: { amount: 120000, method: 'CARD', paidOn: '2026-10-21' },
        }),
      );
      expect(paid).toMatchObject({ status: 'PAID', pendingAmount: 0 });
      expect(paid.payments[0].paidOn).toBe('2026-10-21');
    });

    it('no admite un pago mayor que el gasto ni con día futuro', async () => {
      await expect(
        run(input({ payment: { amount: 120001, method: 'CARD' } })),
      ).rejects.toThrow('El pago supera lo pendiente del gasto (120.000 COP).');
      await expect(
        run(
          input({
            payment: { amount: 1, method: 'CARD', paidOn: '2026-10-24' },
          }),
        ),
      ).rejects.toThrow(PAID_ON_FUTURE_MESSAGE);
      expect(kit.repo.expenses.size).toBe(0);
    });

    it('en efectivo, una clínica que exige caja abierta responde 409', async () => {
      kit.repo.cashRequireOpenSession = true;
      await expect(
        run(input({ payment: { amount: 1000, method: 'CASH' } })),
      ).rejects.toThrow(
        new ConflictException(EXPENSE_CASH_ALWAYS_IN_SESSION_MESSAGE),
      );
      // Otros medios no necesitan caja.
      await expect(
        run(input({ payment: { amount: 1000, method: 'TRANSFER' } })),
      ).resolves.toMatchObject({ status: 'PARTIAL' });
      expect(kit.repo.expenses.size).toBe(1);
    });

    it('en efectivo sin esa exigencia entra sin caja', async () => {
      const out = await run(
        input({ payment: { amount: 1000, method: 'CASH' } }),
      );
      expect(out.payments[0]).toMatchObject({
        method: 'CASH',
        cashSessionId: null,
      });
    });
  });

  describe('pago desde la caja (R1)', () => {
    let link: FakeCashLink;
    beforeEach(() => {
      link = new FakeCashLink();
      create = new CreateExpenseUseCase(
        kit.repo,
        kit.resolver,
        kit.receipts,
        kit.whitelist,
        clock,
        link,
      );
    });
    const fromCash = (patch: Partial<InitialPaymentInput> = {}) =>
      input({
        payment: {
          amount: 1000,
          method: 'CASH',
          fromCashSession: true,
          ...patch,
        },
      });

    it('toma la caja abierta de quien registra en la sede del gasto, con fecha de hoy', async () => {
      const sessionId = link.openSession(ADMIN, LOCATION_ID);
      const out = await run(fromCash());
      expect(out.payments[0]).toMatchObject({
        method: 'CASH',
        paidOn: kit.repo.today,
        cashSessionId: sessionId,
      });
      expect(link.attached).toEqual([
        expect.objectContaining({
          userId: ADMIN,
          locationId: LOCATION_ID,
        }),
      ]);
    });

    it('sin caja abierta en esa sede es 409 y no queda ni gasto ni pago', async () => {
      link.openSession(ADMIN, OTHER_LOCATION_ID);
      await expect(run(fromCash())).rejects.toThrow(
        new ConflictException(OPEN_CASH_SESSION_REQUIRED_MESSAGE),
      );
      expect(kit.repo.expenses.size).toBe(0);
      expect(kit.repo.payments).toHaveLength(0);
    });

    it('es siempre en efectivo y de hoy (400)', async () => {
      link.openSession(ADMIN, LOCATION_ID);
      await expect(run(fromCash({ method: 'CARD' }))).rejects.toThrow(
        new BadRequestException(FROM_CASH_METHOD_MESSAGE),
      );
      await expect(run(fromCash({ paidOn: '2026-10-22' }))).rejects.toThrow(
        new BadRequestException(FROM_CASH_PAID_ON_MESSAGE),
      );
      // Hoy explícito vale.
      await expect(
        run(fromCash({ paidOn: kit.repo.today })),
      ).resolves.toMatchObject({ status: 'PARTIAL' });
    });

    it('con «exigir caja abierta», el efectivo fuera de caja es 409 con el texto de R1', async () => {
      kit.repo.cashRequireOpenSession = true;
      link.openSession(ADMIN, LOCATION_ID);
      await expect(
        run(input({ payment: { amount: 1000, method: 'CASH' } })),
      ).rejects.toThrow(
        'Esta clínica registra el efectivo siempre en una caja abierta.',
      );
      await expect(run(fromCash())).resolves.toMatchObject({
        status: 'PARTIAL',
      });
    });

    it('la huella distingue un pago desde la caja de uno fuera de caja (422)', async () => {
      link.openSession(ADMIN, LOCATION_ID);
      await run(fromCash(), KEY);
      await expect(
        run(input({ payment: { amount: 1000, method: 'CASH' } }), KEY),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });

  describe('soporte', () => {
    it('con attachmentUploadId lo comprueba, lo mueve a su clave y borra el pendiente', async () => {
      const uploadId = await uploadReceipt(kit, pdfFixture());
      const out = await run(input({ attachmentUploadId: uploadId }));
      expect(out.attachment).toMatchObject({
        name: 'factura.pdf',
        mimeType: 'application/pdf',
      });
      const stored = [...kit.repo.expenses.values()][0].attachment!;
      expect(stored.key).toMatch(
        new RegExp(
          `^expense-receipts/[0-9a-f-]+/${uploadId}-[0-9a-f]{16}\\.pdf$`,
        ),
      );
      expect(kit.storage.files.has(stored.key)).toBe(true);
      expect(
        [...kit.storage.files.keys()].some((k) => k.includes('/pending/')),
      ).toBe(false);
    });

    it('un contenido que no es PDF/JPG/PNG da 400 y borra el objeto, sin crear el gasto', async () => {
      const uploadId = await uploadReceipt(kit, htmlFake(), {
        name: 'factura.pdf',
        mimeType: 'application/pdf',
      });
      await expect(
        run(input({ attachmentUploadId: uploadId })),
      ).rejects.toMatchObject({
        response: { message: RECEIPT_TYPE_MESSAGE },
      });
      expect(kit.repo.expenses.size).toBe(0);
      expect(kit.storage.files.size).toBe(0);
    });

    it('una subida de otro usuario o inexistente da 404 y no toca el objeto', async () => {
      const uploadId = await uploadReceipt(
        kit,
        pdfFixture(),
        undefined,
        'otro',
      );
      await expect(
        run(input({ attachmentUploadId: uploadId })),
      ).rejects.toMatchObject({ status: 404 });
      expect(kit.storage.files.size).toBe(1);
      await expect(
        run(
          input({ attachmentUploadId: '9b2f9a6e-3f1c-4d2e-8a55-0d3f6a1b7c10' }),
        ),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('si el alta falla después de copiar el soporte, el definitivo no queda huérfano', async () => {
      const uploadId = await uploadReceipt(kit, jpegFixture(), {
        name: 'foto.jpg',
        mimeType: 'image/jpeg',
      });
      kit.repo.failNextCreate = new Error('boom');
      await expect(
        run(input({ attachmentUploadId: uploadId })),
      ).rejects.toThrow('boom');
      expect(kit.repo.expenses.size).toBe(0);
      expect(
        [...kit.storage.files.keys()].filter((k) => !k.includes('/pending/')),
      ).toEqual([]);
    });
  });

  describe('idempotencia', () => {
    it('signals.replayed: solo la repetición lo marca (la carrera también)', async () => {
      const first: IdempotencySignals = {};
      await kit.inTenant(() => create.execute(input(), ADMIN, KEY, first));
      expect(first.replayed).toBeUndefined();
      const again: IdempotencySignals = {};
      await kit.inTenant(() => create.execute(input(), ADMIN, KEY, again));
      expect(again.replayed).toBe(true);

      // Dos a la vez con otra clave: las dos pasan el atajo; la que pierde
      // recibe `created: false` del repositorio y también se marca.
      const other = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
      const a: IdempotencySignals = {};
      const b: IdempotencySignals = {};
      await Promise.all([
        kit.inTenant(() => create.execute(input(), ADMIN, other, a)),
        kit.inTenant(() => create.execute(input(), ADMIN, other, b)),
      ]);
      expect([a.replayed, b.replayed].filter(Boolean)).toHaveLength(1);
    });

    it('una clave que no es UUID es 400', async () => {
      await expect(run(input(), 'no-es-uuid')).rejects.toThrow(
        new BadRequestException(IDEMPOTENCY_KEY_INVALID_MESSAGE),
      );
    });

    it('repetir la misma petición devuelve el original sin crear otro', async () => {
      const first = await run(input(), KEY);
      const second = await run(input(), KEY);
      expect(second.id).toBe(first.id);
      expect(kit.repo.expenses.size).toBe(1);
    });

    it('la misma clave con otro cuerpo es 422', async () => {
      await run(input(), KEY);
      await expect(run(input({ amount: 99 }), KEY)).rejects.toThrow(
        new UnprocessableEntityException(IDEMPOTENCY_KEY_REUSED_MESSAGE),
      );
      expect(kit.repo.expenses.size).toBe(1);
    });

    it('una repetición no vuelve a validar (el original ya existe)', async () => {
      const first = await run(input(), KEY);
      // Aunque la categoría se retire después, la repetición devuelve el original.
      kit.categories.seed('Otra');
      const again = await run(input(), KEY);
      expect(again.id).toBe(first.id);
    });

    it('la carrera de dos altas simultáneas con la misma clave devuelve el original', async () => {
      const [a, b] = await Promise.all([run(input(), KEY), run(input(), KEY)]);
      expect(a.id).toBe(b.id);
      expect(kit.repo.expenses.size).toBe(1);
    });
  });
});
