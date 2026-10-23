import { ConflictException } from '@nestjs/common';
import type { PaymentMethod } from '@prisma/client';
import {
  CASH_SESSION_REQUIRED_MESSAGE,
  validateFromCashPayment,
  validatePaidOn,
} from '../domain/expense-rules';
import type { ExpenseCashLink } from '../domain/ports/expense-cash-link.port';
import type { ExpenseRepository } from '../domain/ports/expense-repository.port';
import { rule } from './guarded';

export interface PaymentCashRequest {
  method: PaymentMethod;
  paidOn?: string;
  /** «Desde mi caja»: sale del cajón de la caja abierta de quien paga (R1). */
  fromCashSession?: boolean;
}

export interface PaymentCashPlan {
  paidOn: string;
  /** Solo para pagos desde la caja: el repositorio toma la caja con él. */
  cashLink?: ExpenseCashLink;
}

/**
 * El día del pago y si sale de la caja (R1), común al alta con pago y a
 * `POST /expenses/:id/payments`. Desde la caja: efectivo y hoy (400 si no) y
 * la caja la toma el repositorio en la transacción del pago (409 sin caja
 * abierta). Fuera de caja: cualquier medio y día no futuro, salvo efectivo en
 * una clínica que lo exige siempre en caja (409).
 */
export async function planPaymentCash(
  request: PaymentCashRequest,
  today: string,
  repo: Pick<ExpenseRepository, 'cashRequiresOpenSession'>,
  cashLink: ExpenseCashLink | undefined,
): Promise<PaymentCashPlan> {
  if (request.fromCashSession === true) {
    const paidOn = rule(() =>
      validateFromCashPayment(request.method, request.paidOn, today),
    );
    if (!cashLink) {
      // Error de montaje: ExpensesModule importa CashSessionsModule.
      throw new Error('Pago desde la caja sin ExpenseCashLink');
    }
    return { paidOn, cashLink };
  }
  const paidOn =
    request.paidOn === undefined
      ? today
      : rule(() => validatePaidOn(request.paidOn, today));
  if (request.method === 'CASH' && (await repo.cashRequiresOpenSession())) {
    throw new ConflictException(CASH_SESSION_REQUIRED_MESSAGE);
  }
  return { paidOn };
}
