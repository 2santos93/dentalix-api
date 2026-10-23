import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EXPENSE_NOT_FOUND_MESSAGE } from '../../domain/expense-rules';
import {
  buildExpenseTestKit,
  clock,
  type ExpenseTestKit,
} from '../__fixtures__/expense-test-kit';
import {
  LOCATION_ID,
  OTHER_LOCATION_ID,
  USER_ID,
} from '../__fixtures__/in-memory-expenses';
import { GetExpenseUseCase } from './get-expense.use-case';
import {
  EXPORT_MAX_ROWS,
  EXPORT_TOO_MANY_MESSAGE,
  FILTER_DATE_MESSAGE,
  ListExpensesUseCase,
  MAX_PAGE_SIZE,
  RANGE_MESSAGE,
} from './list-expenses.use-case';
import { SuggestSuppliersUseCase } from './suggest-suppliers.use-case';

describe('consultas de gastos (DX-274)', () => {
  let kit: ExpenseTestKit;
  let list: ListExpensesUseCase;

  beforeEach(() => {
    kit = buildExpenseTestKit();
    list = new ListExpensesUseCase(kit.repo, clock);
    kit.repo.users.set(USER_ID, 'Dra. Admin');
  });

  const ids = async (query: Parameters<ListExpensesUseCase['execute']>[0]) =>
    (await kit.inTenant(() => list.execute(query))).items.map(
      (e) => e.supplier,
    );

  describe('lista', () => {
    beforeEach(() => {
      const paid = kit.repo.seed({
        supplier: 'Pagado SA',
        invoiceDate: '2026-10-01',
        amount: 100,
        category: 'Arriendo',
      });
      kit.repo.seedPayment(paid.id, { amount: 100 });
      const partial = kit.repo.seed({
        supplier: 'Parcial SA',
        invoiceDate: '2026-10-05',
        amount: 100,
        dueDate: '2026-10-10',
      });
      kit.repo.seedPayment(partial.id, { amount: 40 });
      kit.repo.seed({
        supplier: 'Pendiente SA',
        invoiceDate: '2026-10-10',
        description: 'Café y papelería',
        locationId: OTHER_LOCATION_ID,
      });
      kit.repo.seed({
        supplier: 'Anulado SA',
        invoiceDate: '2026-10-15',
        voidedAt: new Date(),
        voidedById: USER_ID,
        voidReason: 'duplicado',
      });
    });

    it('más reciente primero por fecha de factura, con estado, pagado y pendiente', async () => {
      const page = await kit.inTenant(() => list.execute({}));
      expect(page.items.map((e) => [e.supplier, e.status])).toEqual([
        ['Anulado SA', 'VOIDED'],
        ['Pendiente SA', 'PENDING'],
        ['Parcial SA', 'PARTIAL'],
        ['Pagado SA', 'PAID'],
      ]);
      expect(page).toMatchObject({ total: 4, page: 1, pageSize: 50 });
      const partial = page.items.find((e) => e.supplier === 'Parcial SA')!;
      expect(partial).toMatchObject({
        paidAmount: 40,
        pendingAmount: 60,
        overdue: true,
        createdByName: 'Dra. Admin',
      });
    });

    it('exporta todas las filas del filtro con el nombre de las sedes', async () => {
      kit.repo.locations.set(LOCATION_ID, 'Norte');
      kit.repo.locations.set(OTHER_LOCATION_ID, 'Sur');
      const out = await kit.inTenant(() =>
        list.exportAll({ status: 'OPEN', pageSize: 1 }),
      );
      expect(out.items.map((e) => e.supplier)).toEqual([
        'Pendiente SA',
        'Parcial SA',
      ]);
      expect(out.locationNames.get(OTHER_LOCATION_ID)).toBe('Sur');
    });

    it('exportar con más de EXPORT_MAX_ROWS filas pide acotar el periodo', async () => {
      const spy = jest.spyOn(kit.repo, 'list').mockResolvedValue({
        items: Array.from({ length: EXPORT_MAX_ROWS + 1 }, () =>
          kit.repo.seed(),
        ) as never,
        total: EXPORT_MAX_ROWS + 1,
        page: 1,
        pageSize: EXPORT_MAX_ROWS + 1,
      });
      await expect(kit.inTenant(() => list.exportAll({}))).rejects.toThrow(
        EXPORT_TOO_MANY_MESSAGE,
      );
      spy.mockRestore();
    });

    it('filtra por estado, OPEN (pendiente + parcial) y vencidos', async () => {
      expect(await ids({ status: 'PAID' })).toEqual(['Pagado SA']);
      expect(await ids({ status: 'VOIDED' })).toEqual(['Anulado SA']);
      expect(await ids({ status: 'OPEN' })).toEqual([
        'Pendiente SA',
        'Parcial SA',
      ]);
      expect(await ids({ overdue: true })).toEqual(['Parcial SA']);
      expect(await ids({ overdue: false })).toHaveLength(3);
    });

    it('filtra por rango de factura (incluyente), sede, categoría y texto', async () => {
      expect(await ids({ from: '2026-10-05', to: '2026-10-10' })).toEqual([
        'Pendiente SA',
        'Parcial SA',
      ]);
      expect(await ids({ locationId: OTHER_LOCATION_ID })).toEqual([
        'Pendiente SA',
      ]);
      expect(await ids({ locationId: LOCATION_ID })).toHaveLength(3);
      expect(await ids({ category: 'ARRIENDO' })).toEqual(['Pagado SA']);
      expect(await ids({ query: 'parcial' })).toEqual(['Parcial SA']);
      expect(await ids({ query: 'CAFE' })).toEqual(['Pendiente SA']);
    });

    it('pagina', async () => {
      const first = await kit.inTenant(() => list.execute({ pageSize: 3 }));
      const second = await kit.inTenant(() =>
        list.execute({ pageSize: 3, page: 2 }),
      );
      expect(first.items).toHaveLength(3);
      expect(second.items.map((e) => e.supplier)).toEqual(['Pagado SA']);
      expect(second.total).toBe(4);
    });

    it('acota la página a 1..100', async () => {
      const page = await kit.inTenant(() =>
        list.execute({ page: -4, pageSize: 5000 }),
      );
      expect(page).toMatchObject({ page: 1, pageSize: MAX_PAGE_SIZE });
    });

    it('valida las fechas del filtro', async () => {
      await expect(
        kit.inTenant(() => list.execute({ from: '2026-13-01' })),
      ).rejects.toThrow(new BadRequestException(FILTER_DATE_MESSAGE));
      await expect(
        kit.inTenant(() =>
          list.execute({ from: '2026-10-10', to: '2026-10-01' }),
        ),
      ).rejects.toThrow(new BadRequestException(RANGE_MESSAGE));
    });
  });

  describe('detalle', () => {
    it('trae el gasto con sus pagos y nombres', async () => {
      const get = new GetExpenseUseCase(kit.repo, clock);
      const e = kit.repo.seed({ amount: 50 });
      kit.repo.seedPayment(e.id, { amount: 20 });
      const out = await kit.inTenant(() => get.execute(e.id));
      expect(out.payments).toHaveLength(1);
      expect(out.payments[0]).toMatchObject({
        amount: 20,
        createdByName: 'Dra. Admin',
      });
      expect(out).not.toHaveProperty('attachmentKey');
    });

    it('no revela la clave del almacén del soporte', async () => {
      const get = new GetExpenseUseCase(kit.repo, clock);
      const e = kit.repo.seed({
        attachment: {
          key: 'expense-receipts/t/u.pdf',
          mime: 'application/pdf',
          size: 10,
          sha256: 'ab'.repeat(32),
          name: 'f.pdf',
        },
      });
      const out = await kit.inTenant(() => get.execute(e.id));
      expect(out.attachment).toEqual({
        name: 'f.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        sha256: 'ab'.repeat(32),
      });
      expect(JSON.stringify(out)).not.toContain('expense-receipts');
    });

    it('404 si no existe', async () => {
      const get = new GetExpenseUseCase(kit.repo, clock);
      await expect(kit.inTenant(() => get.execute('nope'))).rejects.toThrow(
        new NotFoundException(EXPENSE_NOT_FOUND_MESSAGE),
      );
    });
  });

  describe('sugerencias de proveedor', () => {
    it('distintos sin mayúsculas ni tildes, el de uso más reciente primero, hasta 20', async () => {
      const suggest = new SuggestSuppliersUseCase(kit.repo);
      kit.repo.seed({ supplier: 'Papelería Luna' });
      kit.repo.seed({ supplier: 'Aseo Total' });
      kit.repo.seed({ supplier: 'PAPELERIA LUNA' }); // el más reciente de esa clave
      kit.repo.seed({ supplier: null });
      expect(await suggest.execute(undefined)).toEqual([
        'PAPELERIA LUNA',
        'Aseo Total',
      ]);
      expect(await suggest.execute('  lun ')).toEqual(['PAPELERIA LUNA']);
      expect(await suggest.execute('zzz')).toEqual([]);
      expect(kit.repo.lastSupplierQuery).toBe('zzz');
    });

    it('nunca más de 20', async () => {
      const suggest = new SuggestSuppliersUseCase(kit.repo);
      for (let i = 0; i < 25; i++)
        kit.repo.seed({ supplier: `Proveedor ${i}` });
      expect(await suggest.execute('')).toHaveLength(20);
    });
  });
});
