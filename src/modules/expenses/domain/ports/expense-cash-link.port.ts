import type { Prisma } from '@prisma/client';
import type { ExpensePayment } from '../entities/expense.entity';

/**
 * Lo que la caja necesita para tomar la caja de un pago que sale del cajón.
 * Importe, moneda y día no hacen falta: el arqueo los lee de la fila del pago.
 */
export interface ExpenseCashContext {
  tenantId: string;
  /** Sede del gasto: la caja tiene que ser una abierta de esta sede. */
  locationId: string;
  /** Quien paga: su caja abierta es la que se toma. */
  userId: string;
}

/**
 * Punto de extensión hacia la caja (DX-274, R1/R5). El módulo de gastos no
 * conoce las cajas: quien quiera pagar desde el cajón o anular una salida le
 * pasa una implementación al repositorio. La implementa la caja
 * (`ExpenseCashSession`) y `ExpensesModule` importa `CashSessionsModule`, en un
 * solo sentido: la caja no importa el módulo de gastos. Sin implementación (`undefined`), el
 * pago no toca ninguna caja.
 */
export interface ExpenseCashLink {
  /**
   * Toma la caja ABIERTA de `ctx.userId` en la sede del gasto (con `FOR
   * SHARE`, para serializar con el cierre) y devuelve su id. Lanza 409 si no
   * hay. Corre en la transacción del pago.
   */
  attachToOpenSession(
    tx: Prisma.TransactionClient,
    ctx: ExpenseCashContext,
  ): Promise<string>;

  /**
   * Sedes (entre `locationIds`; todas si es `undefined`) donde `userId` tiene
   * su caja abierta. Es una lectura previa: quien escribe vuelve a tomar la
   * caja con `attachToOpenSession` dentro de su transacción.
   */
  openSessionLocations(
    userId: string,
    locationIds: readonly string[] | undefined,
  ): Promise<string[]>;

  /**
   * Un pago CON caja se acaba de anular (ya con su `voidedAt`): la caja
   * resuelve su efecto en el arqueo (R5). Misma transacción.
   */
  onPaymentVoided(
    tx: Prisma.TransactionClient,
    payment: ExpensePayment,
    reason: string,
    by: string,
  ): Promise<void>;
}

/**
 * Token opcional (`@Optional()`) con el que la caja se engancha al gasto.
 * Vacío = los pagos y anulaciones no tocan ninguna caja.
 */
export const EXPENSE_CASH_LINK = Symbol('EXPENSE_CASH_LINK');
