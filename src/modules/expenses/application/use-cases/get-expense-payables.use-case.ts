import { Inject, Injectable } from '@nestjs/common';
import {
  assemblePayables,
  PAYABLE_EXPENSES_LIMIT,
  type PayableCurrencyTotalView,
  type PayableSupplierView,
} from '../../domain/expense-payables';
import {
  EXPENSE_PAYABLES_REPOSITORY,
  type ExpensePayablesRepository,
} from '../../domain/ports/expense-payables-repository.port';
import {
  EXPENSE_REPOSITORY,
  type ExpenseRepository,
} from '../../domain/ports/expense-repository.port';
import { EXPENSE_CLOCK, type ExpenseClock } from '../expense-tokens';
import { type ExpenseView, viewsOf } from '../expense-view';

export interface ExpensePayablesInput {
  locationId?: string;
  currency?: string;
}

export interface ExpensePayablesView {
  /** Una fila por proveedor × moneda, lo más urgente primero. */
  rows: PayableSupplierView[];
  /** Totales por moneda (nunca se suman monedas). */
  totals: PayableCurrencyTotalView[];
}

export interface PayableExpensesInput extends ExpensePayablesInput {
  supplierKey: string;
  currency: string;
}

export interface PayableExpensesView {
  supplierKey: string;
  /** Grafía del gasto abierto más reciente; `null` = «Sin proveedor». */
  supplier: string | null;
  currency: string;
  /** Abiertos por vencimiento (sin vencimiento al final), hasta el tope. */
  items: ExpenseView[];
  /** Cuántos gastos abiertos hay en total (puede pasar del tope). */
  total: number;
}

/** El más reciente por alta (y por id a igualdad), como el SQL del agregado. */
function latestSupplier(items: readonly ExpenseView[]): string | null {
  let latest: ExpenseView | null = null;
  for (const item of items) {
    if (
      !latest ||
      item.createdAt > latest.createdAt ||
      (item.createdAt.getTime() === latest.createdAt.getTime() &&
        item.id > latest.id)
    ) {
      latest = item;
    }
  }
  return latest?.supplier ?? null;
}

/**
 * Cuentas por pagar por proveedor (DX-411, solo ADMIN como el resto de
 * gastos): lo pendiente de los gastos abiertos por proveedor y moneda, con lo
 * vencido y lo que vence en 7 y 30 días con el «hoy» de la sede de cada gasto.
 */
@Injectable()
export class GetExpensePayablesUseCase {
  constructor(
    @Inject(EXPENSE_PAYABLES_REPOSITORY)
    private readonly payablesRepo: ExpensePayablesRepository,
    @Inject(EXPENSE_REPOSITORY) private readonly expenses: ExpenseRepository,
    @Inject(EXPENSE_CLOCK) private readonly clock: ExpenseClock,
  ) {}

  async execute(input: ExpensePayablesInput): Promise<ExpensePayablesView> {
    const rows = await this.payablesRepo.payables(
      { locationId: input.locationId, currency: input.currency },
      this.clock(),
    );
    return assemblePayables(rows);
  }

  /** Los gastos abiertos de un proveedor en una moneda (el detalle). */
  async expensesOf(input: PayableExpensesInput): Promise<PayableExpensesView> {
    const supplierKey = input.supplierKey;
    const found = await this.payablesRepo.payableExpenses(
      {
        locationId: input.locationId,
        currency: input.currency,
        supplierKey,
        limit: PAYABLE_EXPENSES_LIMIT,
      },
      this.clock(),
    );
    const items = await viewsOf(this.expenses, found.items);
    return {
      supplierKey,
      supplier: latestSupplier(items),
      currency: input.currency,
      items,
      total: found.total,
    };
  }
}
