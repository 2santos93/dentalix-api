import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CATEGORY_INVALID_MESSAGE,
  DUE_BEFORE_INVOICE_MESSAGE,
  EXPENSE_NOT_FOUND_MESSAGE,
  EXPENSE_VOIDED_EDIT_MESSAGE,
  HAS_PAYMENTS_MESSAGE,
  INVOICE_DATE_FUTURE_MESSAGE,
} from '../../domain/expense-rules';
import {
  buildExpenseTestKit,
  clock,
  type ExpenseTestKit,
} from '../__fixtures__/expense-test-kit';
import { OTHER_LOCATION_ID, USER_ID } from '../__fixtures__/in-memory-expenses';
import { UNKNOWN_CURRENCY_MESSAGE } from './create-expense.use-case';
import { UpdateExpenseUseCase } from './update-expense.use-case';

describe('edición de un gasto (DX-274)', () => {
  let kit: ExpenseTestKit;
  let update: UpdateExpenseUseCase;
  const run = (
    id: string,
    body: Parameters<UpdateExpenseUseCase['execute']>[1],
  ) => kit.inTenant(() => update.execute(id, body));

  beforeEach(() => {
    kit = buildExpenseTestKit();
    update = new UpdateExpenseUseCase(
      kit.repo,
      kit.resolver,
      kit.whitelist,
      clock,
    );
  });

  it('cambia categoría, proveedor, descripción y fechas de un gasto sin pagos', async () => {
    const e = kit.repo.seed({ supplier: 'Viejo', description: 'x' });
    const out = await run(e.id, {
      category: 'laboratorio',
      supplier: '  Lab   Uno ',
      description: 'Coronas',
      invoiceDate: '2026-10-21',
      dueDate: '2026-11-30',
    });
    expect(out).toMatchObject({
      category: 'Laboratorio',
      supplier: 'Lab Uno',
      description: 'Coronas',
      invoiceDate: '2026-10-21',
      dueDate: '2026-11-30',
    });
  });

  it('null vacía proveedor, descripción y vencimiento', async () => {
    const e = kit.repo.seed({
      supplier: 'S',
      description: 'D',
      dueDate: '2026-11-01',
    });
    expect(
      await run(e.id, { supplier: null, description: null, dueDate: null }),
    ).toMatchObject({ supplier: null, description: null, dueDate: null });
  });

  it('un cuerpo sin cambios devuelve el gasto tal cual', async () => {
    const e = kit.repo.seed({ category: 'Arriendo' });
    const out = await run(e.id, { category: 'Arriendo', amount: undefined });
    expect(out.updatedAt).toEqual(e.updatedAt);
  });

  it('404 si no existe', async () => {
    await expect(run('nope', { description: 'x' })).rejects.toThrow(
      new NotFoundException(EXPENSE_NOT_FOUND_MESSAGE),
    );
  });

  it('un gasto anulado no se edita (409)', async () => {
    const e = kit.repo.seed({
      voidedAt: new Date(),
      voidedById: USER_ID,
      voidReason: 'duplicado',
    });
    await expect(run(e.id, { description: 'x' })).rejects.toThrow(
      new ConflictException(EXPENSE_VOIDED_EDIT_MESSAGE),
    );
  });

  describe('categoría', () => {
    it('una desconocida es 400', async () => {
      const e = kit.repo.seed();
      await expect(run(e.id, { category: 'Inventada' })).rejects.toThrow(
        CATEGORY_INVALID_MESSAGE,
      );
    });

    it('conservar la categoría de siempre vale aunque ya esté retirada', async () => {
      const e = kit.repo.seed({ category: 'Seguros viejos' });
      const out = await run(e.id, {
        category: 'Seguros viejos',
        description: 'x',
      });
      expect(out.category).toBe('Seguros viejos');
    });
  });

  describe('fechas', () => {
    it('la factura no puede ser futura respecto a la sede', async () => {
      const e = kit.repo.seed();
      await expect(run(e.id, { invoiceDate: '2026-10-24' })).rejects.toThrow(
        INVOICE_DATE_FUTURE_MESSAGE,
      );
    });

    it('el vencimiento no puede quedar antes de la factura, ni al moverla', async () => {
      const e = kit.repo.seed({
        invoiceDate: '2026-10-01',
        dueDate: '2026-10-10',
      });
      await expect(run(e.id, { dueDate: '2026-09-30' })).rejects.toThrow(
        DUE_BEFORE_INVOICE_MESSAGE,
      );
      await expect(run(e.id, { invoiceDate: '2026-10-15' })).rejects.toThrow(
        DUE_BEFORE_INVOICE_MESSAGE,
      );
      await expect(
        run(e.id, { invoiceDate: '2026-10-15', dueDate: '2026-10-20' }),
      ).resolves.toMatchObject({ invoiceDate: '2026-10-15' });
    });
  });

  describe('importe, moneda y sede', () => {
    it('sin pagos cambian los tres', async () => {
      const e = kit.repo.seed({ amount: 100 });
      const out = await run(e.id, {
        amount: 250.5,
        currency: 'usd',
        locationId: OTHER_LOCATION_ID,
      });
      expect(out).toMatchObject({
        amount: 250.5,
        currency: 'USD',
        locationId: OTHER_LOCATION_ID,
      });
    });

    it('una moneda desconocida es 400', async () => {
      const e = kit.repo.seed();
      await expect(run(e.id, { currency: 'ZZZ' })).rejects.toThrow(
        UNKNOWN_CURRENCY_MESSAGE,
      );
    });

    it('con un pago vivo el importe puede subir y bajar hasta lo pagado, no menos', async () => {
      const e = kit.repo.seed({ amount: 100 });
      kit.repo.seedPayment(e.id, { amount: 40 });
      expect((await run(e.id, { amount: 40 })).status).toBe('PAID');
      expect((await run(e.id, { amount: 90 })).status).toBe('PARTIAL');
      await expect(run(e.id, { amount: 39.99 })).rejects.toThrow(
        'El importe no puede ser menor a lo ya pagado (40 COP).',
      );
    });

    it('con CUALQUIER pago (también anulado) la sede y la moneda no cambian', async () => {
      const e = kit.repo.seed();
      kit.repo.seedPayment(e.id, {
        voidedAt: new Date(),
        voidedById: USER_ID,
        voidReason: 'error de digitación',
      });
      await expect(run(e.id, { currency: 'USD' })).rejects.toThrow(
        new ConflictException(HAS_PAYMENTS_MESSAGE),
      );
      await expect(
        run(e.id, { locationId: OTHER_LOCATION_ID }),
      ).rejects.toThrow(HAS_PAYMENTS_MESSAGE);
      // El importe sí: el pago anulado no cuenta como pagado.
      await expect(run(e.id, { amount: 1 })).resolves.toMatchObject({
        amount: 1,
      });
    });
  });
});
