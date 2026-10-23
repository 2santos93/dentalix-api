import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  EXPENSE_ALREADY_VOIDED_MESSAGE,
  EXPENSE_NOT_FOUND_MESSAGE,
  VOID_REASON_MESSAGE,
} from '../../domain/expense-rules';
import type { ExpenseCashLink } from '../../domain/ports/expense-cash-link.port';
import {
  ADMIN,
  buildExpenseTestKit,
  clock,
  type ExpenseTestKit,
} from '../__fixtures__/expense-test-kit';
import { VoidExpenseUseCase } from './void-expense.use-case';
import { VoidExpensePaymentUseCase } from './void-expense-payment.use-case';

describe('anulación de un gasto (DX-274)', () => {
  let kit: ExpenseTestKit;
  const voidWith = (cashLink?: ExpenseCashLink) =>
    new VoidExpenseUseCase(kit.repo, clock, cashLink);
  const run = (id: string, reason: string | undefined, uc = voidWith()) =>
    kit.inTenant(() => uc.execute(id, reason, ADMIN));

  beforeEach(() => {
    kit = buildExpenseTestKit();
  });

  it('anula el gasto Y todos sus pagos vivos, con el motivo', async () => {
    const e = kit.repo.seed({ amount: 100 });
    const live1 = kit.repo.seedPayment(e.id, { amount: 30 });
    const live2 = kit.repo.seedPayment(e.id, { amount: 20 });
    const already = kit.repo.seedPayment(e.id, {
      amount: 5,
      voidedAt: new Date('2026-10-22T00:00:00Z'),
      voidedById: 'otro',
      voidReason: 'error anterior',
    });
    const out = await run(e.id, ' Factura duplicada ');
    expect(out).toMatchObject({
      status: 'VOIDED',
      pendingAmount: 0,
      voidedById: ADMIN,
      voidReason: 'Factura duplicada',
    });
    expect(out.voidedAt).not.toBeNull();
    const byId = new Map(out.payments.map((p) => [p.id, p]));
    for (const p of [live1, live2]) {
      expect(byId.get(p.id)).toMatchObject({
        voidedById: ADMIN,
        voidReason: 'Factura duplicada',
      });
    }
    // El que ya estaba anulado conserva su anulación.
    expect(byId.get(already.id)).toMatchObject({
      voidedById: 'otro',
      voidReason: 'error anterior',
    });
  });

  it('exige motivo de 5 caracteres, y una sola vez (409)', async () => {
    const e = kit.repo.seed();
    await expect(run(e.id, 'abcd')).rejects.toThrow(VOID_REASON_MESSAGE);
    await expect(run(e.id, undefined)).rejects.toThrow(VOID_REASON_MESSAGE);
    await run(e.id, 'Gasto de prueba');
    await expect(run(e.id, 'Gasto de prueba')).rejects.toThrow(
      new ConflictException(EXPENSE_ALREADY_VOIDED_MESSAGE),
    );
  });

  it('404 si no existe', async () => {
    await expect(run('nope', 'Gasto de prueba')).rejects.toThrow(
      new NotFoundException(EXPENSE_NOT_FOUND_MESSAGE),
    );
  });

  it('un pago con caja pasa por el enlace de la caja (R5); sin enlace falla fuerte', async () => {
    const e = kit.repo.seed({ amount: 100 });
    const cashPayment = kit.repo.seedPayment(e.id, {
      amount: 50,
      method: 'CASH',
      cashSessionId: 'caja-1',
    });
    kit.repo.seedPayment(e.id, { amount: 10 });

    await expect(run(e.id, 'Gasto de prueba')).rejects.toThrow(
      'Un pago con caja se anula con su CashLink',
    );

    const seen: string[] = [];
    const link: ExpenseCashLink = {
      attachToOpenSession: () => Promise.reject(new Error('no se usa')),
      openSessionLocations: () => Promise.reject(new Error('no se usa')),
      onPaymentVoided: (_tx, payment, reason, by) => {
        seen.push(`${payment.id}|${reason}|${by}`);
        return Promise.resolve();
      },
    };
    const out = await run(e.id, 'Gasto de prueba', voidWith(link));
    expect(out.status).toBe('VOIDED');
    // Solo el pago con caja llega al enlace.
    expect(seen).toEqual([`${cashPayment.id}|Gasto de prueba|${ADMIN}`]);
  });

  it('anular un pago con caja también pasa por el enlace', async () => {
    const e = kit.repo.seed({ amount: 100 });
    const p = kit.repo.seedPayment(e.id, {
      method: 'CASH',
      cashSessionId: 'caja-1',
    });
    const seen: string[] = [];
    const link: ExpenseCashLink = {
      attachToOpenSession: () => Promise.reject(new Error('no se usa')),
      openSessionLocations: () => Promise.reject(new Error('no se usa')),
      onPaymentVoided: (_tx, payment) => {
        seen.push(payment.id);
        return Promise.resolve();
      },
    };
    await kit.inTenant(() =>
      new VoidExpensePaymentUseCase(kit.repo, clock, link).execute(
        e.id,
        p.id,
        'Salida mal digitada',
        ADMIN,
      ),
    );
    expect(seen).toEqual([p.id]);
  });
});
