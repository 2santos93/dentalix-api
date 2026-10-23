import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CASH_SESSION_REQUIRED_MESSAGE,
  EXPENSE_NOT_FOUND_MESSAGE,
  FROM_CASH_METHOD_MESSAGE,
  FROM_CASH_PAID_ON_MESSAGE,
  OPEN_CASH_SESSION_REQUIRED_MESSAGE,
  EXPENSE_VOIDED_MESSAGE,
  IDEMPOTENCY_KEY_INVALID_MESSAGE,
  IDEMPOTENCY_KEY_REUSED_MESSAGE,
  PAID_ON_FUTURE_MESSAGE,
  PAYMENT_ALREADY_VOIDED_MESSAGE,
  PAYMENT_NOT_FOUND_MESSAGE,
  VOID_REASON_MESSAGE,
} from '../../domain/expense-rules';
import {
  ADMIN,
  buildExpenseTestKit,
  clock,
  type ExpenseTestKit,
  FakeCashLink,
} from '../__fixtures__/expense-test-kit';
import {
  LOCATION_ID,
  OTHER_LOCATION_ID,
  USER_ID,
} from '../__fixtures__/in-memory-expenses';
import type { IdempotencySignals } from '../idempotency-guard';
import {
  AddExpensePaymentUseCase,
  type AddExpensePaymentInput,
} from './add-expense-payment.use-case';
import { VoidExpensePaymentUseCase } from './void-expense-payment.use-case';

const KEY = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('pagos de un gasto (DX-274)', () => {
  let kit: ExpenseTestKit;
  let add: AddExpensePaymentUseCase;
  let voidPayment: VoidExpensePaymentUseCase;
  const pay = (id: string, body: AddExpensePaymentInput, key?: string) =>
    kit.inTenant(() => add.execute(id, body, ADMIN, key));

  beforeEach(() => {
    kit = buildExpenseTestKit();
    add = new AddExpensePaymentUseCase(kit.repo, clock);
    voidPayment = new VoidExpensePaymentUseCase(kit.repo, clock);
  });

  describe('registrar', () => {
    it('un pago parcial deja el gasto PARTIAL y uno que completa lo deja PAID', async () => {
      const e = kit.repo.seed({ amount: 100 });
      expect(await pay(e.id, { amount: 30, method: 'CARD' })).toMatchObject({
        status: 'PARTIAL',
        paidAmount: 30,
        pendingAmount: 70,
      });
      const out = await pay(e.id, {
        amount: 70,
        method: 'TRANSFER',
        paidOn: '2026-10-22',
      });
      expect(out).toMatchObject({ status: 'PAID', pendingAmount: 0 });
      expect(out.payments.map((p) => [p.amount, p.method, p.paidOn])).toEqual([
        [30, 'CARD', '2026-10-23'],
        [70, 'TRANSFER', '2026-10-22'],
      ]);
      expect(out.payments[0]).toMatchObject({
        createdById: ADMIN,
        cashSessionId: null,
      });
    });

    it('el tope (R2): un céntimo de más es 400 con lo pendiente', async () => {
      const e = kit.repo.seed({ amount: 100 });
      await pay(e.id, { amount: 99.5, method: 'CARD' });
      await expect(pay(e.id, { amount: 0.51, method: 'CARD' })).rejects.toThrow(
        new BadRequestException(
          'El pago supera lo pendiente del gasto (0,50 COP).',
        ),
      );
      await expect(
        pay(e.id, { amount: 0.5, method: 'CARD' }),
      ).resolves.toMatchObject({
        status: 'PAID',
      });
    });

    it('anular un pago libera su importe para volver a pagar', async () => {
      const e = kit.repo.seed({ amount: 100 });
      const paid = await pay(e.id, { amount: 100, method: 'CARD' });
      await kit.inTenant(() =>
        voidPayment.execute(
          e.id,
          paid.payments[0].id,
          'Se pagó por error',
          ADMIN,
        ),
      );
      await expect(
        pay(e.id, { amount: 100, method: 'TRANSFER' }),
      ).resolves.toMatchObject({ status: 'PAID' });
    });

    it('no admite importe inválido, día futuro ni gasto inexistente o anulado', async () => {
      const e = kit.repo.seed({ amount: 100 });
      await expect(pay(e.id, { amount: 0, method: 'CARD' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        pay(e.id, { amount: 1, method: 'CARD', paidOn: '2026-10-24' }),
      ).rejects.toThrow(PAID_ON_FUTURE_MESSAGE);
      await expect(pay('nope', { amount: 1, method: 'CARD' })).rejects.toThrow(
        new NotFoundException(EXPENSE_NOT_FOUND_MESSAGE),
      );
      const voided = kit.repo.seed({
        voidedAt: new Date(),
        voidedById: USER_ID,
        voidReason: 'duplicado',
      });
      await expect(
        pay(voided.id, { amount: 1, method: 'CARD' }),
      ).rejects.toThrow(new ConflictException(EXPENSE_VOIDED_MESSAGE));
    });

    it('en efectivo, una clínica que exige caja abierta responde 409 y no registra nada', async () => {
      kit.repo.cashRequireOpenSession = true;
      const e = kit.repo.seed({ amount: 100 });
      await expect(pay(e.id, { amount: 10, method: 'CASH' })).rejects.toThrow(
        new ConflictException(CASH_SESSION_REQUIRED_MESSAGE),
      );
      expect(kit.repo.paymentsOf(e.id)).toHaveLength(0);
      await expect(
        pay(e.id, { amount: 10, method: 'CARD' }),
      ).resolves.toBeDefined();
    });

    it('«hoy» es el de la sede del gasto', async () => {
      const e = kit.repo.seed({ amount: 100 });
      kit.repo.today = '2026-10-24';
      const out = await pay(e.id, { amount: 1, method: 'CARD' });
      expect(out.payments[0].paidOn).toBe('2026-10-24');
    });
  });

  describe('idempotencia', () => {
    it('signals.replayed: solo la repetición lo marca (la carrera también)', async () => {
      const e = kit.repo.seed({ amount: 100 });
      const body = { amount: 10, method: 'CARD' as const };
      const first: IdempotencySignals = {};
      await kit.inTenant(() => add.execute(e.id, body, ADMIN, KEY, first));
      expect(first.replayed).toBeUndefined();
      const again: IdempotencySignals = {};
      await kit.inTenant(() => add.execute(e.id, body, ADMIN, KEY, again));
      expect(again.replayed).toBe(true);

      const other = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
      const a: IdempotencySignals = {};
      const b: IdempotencySignals = {};
      await Promise.all([
        kit.inTenant(() => add.execute(e.id, body, ADMIN, other, a)),
        kit.inTenant(() => add.execute(e.id, body, ADMIN, other, b)),
      ]);
      expect([a.replayed, b.replayed].filter(Boolean)).toHaveLength(1);
      expect(kit.repo.paymentsOf(e.id)).toHaveLength(2);
    });

    it('repetir el mismo pago con la misma clave no lo duplica', async () => {
      const e = kit.repo.seed({ amount: 100 });
      await pay(e.id, { amount: 10, method: 'CARD' }, KEY);
      const again = await pay(e.id, { amount: 10, method: 'CARD' }, KEY);
      expect(again.payments).toHaveLength(1);
      expect(again.paidAmount).toBe(10);
    });

    it('la misma clave con otro importe, otro medio u otro gasto es 422', async () => {
      const e = kit.repo.seed({ amount: 100 });
      const other = kit.repo.seed({ amount: 100 });
      await pay(e.id, { amount: 10, method: 'CARD' }, KEY);
      const reused = new UnprocessableEntityException(
        IDEMPOTENCY_KEY_REUSED_MESSAGE,
      );
      await expect(
        pay(e.id, { amount: 11, method: 'CARD' }, KEY),
      ).rejects.toThrow(reused);
      await expect(
        pay(e.id, { amount: 10, method: 'CASH' }, KEY),
      ).rejects.toThrow(reused);
      await expect(
        pay(other.id, { amount: 10, method: 'CARD' }, KEY),
      ).rejects.toThrow(reused);
      expect(kit.repo.paymentsOf(e.id)).toHaveLength(1);
    });

    it('una clave que no es UUID es 400', async () => {
      const e = kit.repo.seed();
      await expect(
        pay(e.id, { amount: 1, method: 'CARD' }, 'x'),
      ).rejects.toThrow(
        new BadRequestException(IDEMPOTENCY_KEY_INVALID_MESSAGE),
      );
    });

    it('dos pagos simultáneos con la misma clave dejan uno', async () => {
      const e = kit.repo.seed({ amount: 100 });
      await Promise.all([
        pay(e.id, { amount: 10, method: 'CARD' }, KEY),
        pay(e.id, { amount: 10, method: 'CARD' }, KEY),
      ]);
      expect(kit.repo.paymentsOf(e.id)).toHaveLength(1);
    });
  });

  describe('pago desde la caja (R1)', () => {
    let link: FakeCashLink;
    beforeEach(() => {
      link = new FakeCashLink();
      add = new AddExpensePaymentUseCase(kit.repo, clock, link);
    });

    it('sale de la caja abierta de quien paga en la sede del gasto', async () => {
      const e = kit.repo.seed({ amount: 100, locationId: OTHER_LOCATION_ID });
      const sessionId = link.openSession(ADMIN, OTHER_LOCATION_ID);
      const out = await pay(e.id, {
        amount: 40,
        method: 'CASH',
        fromCashSession: true,
      });
      expect(out.payments[0]).toMatchObject({
        cashSessionId: sessionId,
        paidOn: kit.repo.today,
      });
    });

    it('sin caja abierta en la sede del gasto es 409 y no registra nada', async () => {
      const e = kit.repo.seed({ amount: 100 });
      link.openSession(ADMIN, OTHER_LOCATION_ID);
      await expect(
        pay(e.id, { amount: 40, method: 'CASH', fromCashSession: true }),
      ).rejects.toThrow(
        new ConflictException(OPEN_CASH_SESSION_REQUIRED_MESSAGE),
      );
      expect(kit.repo.paymentsOf(e.id)).toHaveLength(0);
    });

    it('es en efectivo y de hoy (400), y la huella lo distingue', async () => {
      const e = kit.repo.seed({ amount: 100 });
      link.openSession(ADMIN, LOCATION_ID);
      await expect(
        pay(e.id, { amount: 1, method: 'TRANSFER', fromCashSession: true }),
      ).rejects.toThrow(new BadRequestException(FROM_CASH_METHOD_MESSAGE));
      await expect(
        pay(e.id, {
          amount: 1,
          method: 'CASH',
          paidOn: '2026-10-01',
          fromCashSession: true,
        }),
      ).rejects.toThrow(new BadRequestException(FROM_CASH_PAID_ON_MESSAGE));
      await pay(
        e.id,
        { amount: 1, method: 'CASH', fromCashSession: true },
        KEY,
      );
      await expect(
        pay(e.id, { amount: 1, method: 'CASH' }, KEY),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('con «exigir caja abierta», desde la caja sí se acepta', async () => {
      kit.repo.cashRequireOpenSession = true;
      const e = kit.repo.seed({ amount: 100 });
      link.openSession(ADMIN, LOCATION_ID);
      await expect(pay(e.id, { amount: 10, method: 'CASH' })).rejects.toThrow(
        new ConflictException(CASH_SESSION_REQUIRED_MESSAGE),
      );
      await expect(
        pay(e.id, { amount: 10, method: 'CASH', fromCashSession: true }),
      ).resolves.toMatchObject({ status: 'PARTIAL' });
    });
  });

  describe('anular un pago', () => {
    it('lo anula con motivo y quién; el gasto vuelve a deber ese importe', async () => {
      const e = kit.repo.seed({ amount: 100 });
      const p = kit.repo.seedPayment(e.id, { amount: 100 });
      const out = await kit.inTenant(() =>
        voidPayment.execute(e.id, p.id, '  Pago duplicado ', ADMIN),
      );
      expect(out).toMatchObject({
        status: 'PENDING',
        paidAmount: 0,
        pendingAmount: 100,
      });
      expect(out.payments[0]).toMatchObject({
        voidedById: ADMIN,
        voidReason: 'Pago duplicado',
      });
      expect(out.payments[0].voidedAt).not.toBeNull();
    });

    it('el motivo exige 5 caracteres', async () => {
      const e = kit.repo.seed();
      const p = kit.repo.seedPayment(e.id);
      await expect(
        kit.inTenant(() => voidPayment.execute(e.id, p.id, 'ab', ADMIN)),
      ).rejects.toThrow(VOID_REASON_MESSAGE);
    });

    it('una sola vez (409) y solo si el pago es de ese gasto (404)', async () => {
      const e = kit.repo.seed();
      const other = kit.repo.seed();
      const p = kit.repo.seedPayment(e.id);
      await kit.inTenant(() =>
        voidPayment.execute(e.id, p.id, 'Pago duplicado', ADMIN),
      );
      await expect(
        kit.inTenant(() =>
          voidPayment.execute(e.id, p.id, 'Pago duplicado', ADMIN),
        ),
      ).rejects.toThrow(new ConflictException(PAYMENT_ALREADY_VOIDED_MESSAGE));
      await expect(
        kit.inTenant(() =>
          voidPayment.execute(other.id, p.id, 'Pago duplicado', ADMIN),
        ),
      ).rejects.toThrow(new NotFoundException(PAYMENT_NOT_FOUND_MESSAGE));
    });
  });
});
