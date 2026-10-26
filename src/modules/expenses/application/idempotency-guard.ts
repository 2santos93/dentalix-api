import { UnprocessableEntityException } from '@nestjs/common';
import { IDEMPOTENCY_KEY_REUSED_MESSAGE } from '../domain/expense-rules';

/**
 * Lo que un caso de uso le deja al controlador: `replayed` = la petición
 * repetía una anterior con la misma Idempotency-Key y devolvió el original
 * (el controlador no vuelve a auditarla: no escribió nada).
 */
export interface IdempotencySignals {
  replayed?: boolean;
}

const reused = () =>
  new UnprocessableEntityException(IDEMPOTENCY_KEY_REUSED_MESSAGE);

/** ¿Es el mismo cuerpo que creó la fila? Si no, la clave se reutilizó mal (422). */
export function assertSameRequest(
  stored: string | null,
  current: string | undefined,
): void {
  if (stored !== null && current !== undefined && stored !== current) {
    throw reused();
  }
}

/** Igual para un pago: además tiene que ser del mismo gasto de la ruta. */
export function assertSamePayment(
  stored: { expenseId: string; fingerprint: string | null },
  expenseId: string,
  current: string | undefined,
): void {
  if (stored.expenseId !== expenseId) throw reused();
  assertSameRequest(stored.fingerprint, current);
}
