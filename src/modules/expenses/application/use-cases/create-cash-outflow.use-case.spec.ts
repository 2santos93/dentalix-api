import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CASH_SESSION_IN_SEVERAL_LOCATIONS_MESSAGE,
  IDEMPOTENCY_KEY_INVALID_MESSAGE,
  OPEN_CASH_SESSION_REQUIRED_MESSAGE,
} from '../../domain/expense-rules';
import {
  buildExpenseTestKit,
  clock,
  type ExpenseTestKit,
  FakeCashLink,
  RECEPTION,
} from '../__fixtures__/expense-test-kit';
import {
  LOCATION_ID,
  OTHER_LOCATION_ID,
  TENANT_ID,
} from '../__fixtures__/in-memory-expenses';
import {
  type CashOutflowInput,
  CreateCashOutflowUseCase,
} from './create-cash-outflow.use-case';
import { CreateExpenseUseCase } from './create-expense.use-case';

const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const body = (patch: Partial<CashOutflowInput> = {}): CashOutflowInput => ({
  category: 'Mensajería',
  supplier: ' Rappi ',
  description: 'Envío de modelos al laboratorio',
  amount: 15000,
  currency: 'cop',
  ...patch,
});

describe('salida de caja menor (DX-274)', () => {
  let kit: ExpenseTestKit;
  let link: FakeCashLink;
  let outflow: CreateCashOutflowUseCase;
  const run = (
    input: CashOutflowInput,
    key?: string,
    user = RECEPTION,
    headerLocation?: string,
  ) =>
    kit.tenant.run(TENANT_ID, headerLocation, () =>
      outflow.execute(input, user, key),
    );

  beforeEach(() => {
    kit = buildExpenseTestKit();
    link = new FakeCashLink();
    const create = new CreateExpenseUseCase(
      kit.repo,
      kit.resolver,
      kit.receipts,
      kit.whitelist,
      clock,
      link,
    );
    outflow = new CreateCashOutflowUseCase(
      create,
      kit.repo,
      kit.tenant,
      clock,
      link,
    );
  });

  it('crea un gasto de la sede de la caja, de hoy, pagado en efectivo desde esa caja', async () => {
    kit.repo.today = '2026-10-23';
    const sessionId = link.openSession(RECEPTION, OTHER_LOCATION_ID);
    const out = await run(body());
    expect(out).toMatchObject({
      locationId: OTHER_LOCATION_ID,
      category: 'Mensajería',
      supplier: 'Rappi',
      amount: 15000,
      currency: 'COP',
      invoiceDate: '2026-10-23',
      status: 'PAID',
      createdById: RECEPTION,
    });
    expect(out.payments).toEqual([
      expect.objectContaining({
        amount: 15000,
        method: 'CASH',
        paidOn: '2026-10-23',
        cashSessionId: sessionId,
      }),
    ]);
    // La respuesta es el gasto: nada del esperado de la caja.
    expect(JSON.stringify(out)).not.toMatch(/expected/i);
  });

  it('sin caja abierta es 409 y no crea nada', async () => {
    await expect(run(body())).rejects.toThrow(
      new ConflictException(OPEN_CASH_SESSION_REQUIRED_MESSAGE),
    );
    expect(kit.repo.expenses.size).toBe(0);
  });

  it('solo la caja de quien la registra: la de otro usuario no vale', async () => {
    link.openSession('cccccccc-cccc-4ccc-8ccc-cccccccccccc', LOCATION_ID);
    await expect(run(body())).rejects.toThrow(
      new ConflictException(OPEN_CASH_SESSION_REQUIRED_MESSAGE),
    );
  });

  it('con X-Location-Id, la caja tiene que ser de esa sede', async () => {
    link.openSession(RECEPTION, LOCATION_ID);
    await expect(
      run(body(), undefined, RECEPTION, OTHER_LOCATION_ID),
    ).rejects.toThrow(
      new ConflictException(OPEN_CASH_SESSION_REQUIRED_MESSAGE),
    );
    expect(link.lastScope).toEqual([OTHER_LOCATION_ID]);
    const out = await run(body(), undefined, RECEPTION, LOCATION_ID);
    expect(out.locationId).toBe(LOCATION_ID);
  });

  it('con cajas abiertas en varias sedes y sin elegir, 409', async () => {
    link.openSession(RECEPTION, LOCATION_ID);
    link.openSession(RECEPTION, OTHER_LOCATION_ID);
    await expect(run(body())).rejects.toThrow(
      new ConflictException(CASH_SESSION_IN_SEVERAL_LOCATIONS_MESSAGE),
    );
  });

  it('las reglas del gasto aplican (importe, categoría)', async () => {
    link.openSession(RECEPTION, LOCATION_ID);
    await expect(run(body({ amount: 0 }))).rejects.toThrow(BadRequestException);
    await expect(run(body({ category: 'Inventada' }))).rejects.toThrow(
      BadRequestException,
    );
    expect(kit.repo.expenses.size).toBe(0);
  });

  describe('idempotencia', () => {
    it('repetir la misma salida devuelve la original, aunque la caja ya se haya cerrado', async () => {
      link.openSession(RECEPTION, LOCATION_ID);
      const first = await run(body(), KEY);
      link.open.clear();
      const again = await run(body({ supplier: 'Rappi' }), KEY);
      expect(again.id).toBe(first.id);
      expect(kit.repo.expenses.size).toBe(1);
      expect(kit.repo.payments).toHaveLength(1);
    });

    it('otra salida con la misma clave es 422; una clave que no es UUID, 400', async () => {
      link.openSession(RECEPTION, LOCATION_ID);
      await run(body(), KEY);
      await expect(run(body({ amount: 1 }), KEY)).rejects.toThrow(
        UnprocessableEntityException,
      );
      await expect(run(body(), 'no-es-uuid')).rejects.toThrow(
        new BadRequestException(IDEMPOTENCY_KEY_INVALID_MESSAGE),
      );
    });
  });
});
