import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CURRENCY_WHITELIST } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import type { CurrencyWhitelist } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import {
  EXPENSE_NOT_FOUND_MESSAGE,
  EXPENSE_VOIDED_EDIT_MESSAGE,
  validateAmount,
  validateDescription,
  validateDueDate,
  validateInvoiceDate,
  validateSupplier,
} from '../../domain/expense-rules';
import {
  EXPENSE_REPOSITORY,
  type ExpenseRepository,
  type UpdateExpenseRepoInput,
} from '../../domain/ports/expense-repository.port';
import { ExpenseCategoryResolver } from '../expense-category-resolver';
import { EXPENSE_CLOCK, type ExpenseClock } from '../expense-tokens';
import { type ExpenseDetailView, detailViewOf } from '../expense-view';
import { guarded, rule } from '../guarded';
import { UNKNOWN_CURRENCY_MESSAGE } from './create-expense.use-case';

/** Ausente = no se toca; `null` vacía proveedor, descripción y vencimiento. */
export interface UpdateExpenseInput {
  category?: string;
  supplier?: string | null;
  description?: string | null;
  invoiceDate?: string;
  dueDate?: string | null;
  amount?: number;
  currency?: string;
  locationId?: string;
}

@Injectable()
export class UpdateExpenseUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly repo: ExpenseRepository,
    private readonly categories: ExpenseCategoryResolver,
    @Inject(CURRENCY_WHITELIST) private readonly whitelist: CurrencyWhitelist,
    @Inject(EXPENSE_CLOCK) private readonly clock: ExpenseClock,
  ) {}

  /**
   * Valida cada campo que llega contra el gasto actual y deja la regla que
   * depende de los pagos (sede, moneda, importe) al repositorio, que la aplica
   * con el gasto bloqueado. Un campo igual al actual no cuenta como cambio.
   */
  async execute(
    id: string,
    input: UpdateExpenseInput,
  ): Promise<ExpenseDetailView> {
    const now = this.clock();
    const current = await this.repo.findById(id, now);
    if (!current) throw new NotFoundException(EXPENSE_NOT_FOUND_MESSAGE);
    if (current.voidedAt) {
      throw new ConflictException(EXPENSE_VOIDED_EDIT_MESSAGE);
    }

    const patch: UpdateExpenseRepoInput = {};
    if (input.category !== undefined) {
      // Conservar la categoría de siempre es válido aunque ya esté retirada.
      const same = input.category.trim() === current.category;
      patch.category = same
        ? undefined
        : await this.categories.resolve(input.category);
    }
    if (input.supplier !== undefined) {
      patch.supplier = rule(() => validateSupplier(input.supplier));
    }
    if (input.description !== undefined) {
      patch.description = rule(() => validateDescription(input.description));
    }
    if (input.amount !== undefined) {
      patch.amount = rule(() => validateAmount(input.amount));
    }
    if (input.currency !== undefined) {
      const currency = input.currency.trim().toUpperCase();
      if (!(await this.whitelist.has(currency))) {
        throw new BadRequestException(UNKNOWN_CURRENCY_MESSAGE);
      }
      patch.currency = currency;
    }

    // El «hoy» de la sede donde quedará el gasto.
    let locationId = current.locationId;
    let today: string | undefined;
    if (
      input.locationId !== undefined &&
      input.locationId !== current.locationId
    ) {
      const target = await guarded(() =>
        this.repo.resolveLocation(input.locationId, now),
      );
      patch.locationId = target.locationId;
      locationId = target.locationId;
      today = target.today;
    }
    const invoiceDate = input.invoiceDate;
    if (invoiceDate !== undefined) {
      today ??= await this.repo.locationToday(locationId, now);
      const day = rule(() => validateInvoiceDate(invoiceDate, today!));
      patch.invoiceDate = day;
    }
    const finalInvoice = patch.invoiceDate ?? current.invoiceDate;
    if (input.dueDate !== undefined) {
      patch.dueDate = rule(() => validateDueDate(input.dueDate, finalInvoice));
    } else if (patch.invoiceDate !== undefined && current.dueDate) {
      // Mover la factura no puede dejar el vencimiento por detrás.
      rule(() => validateDueDate(current.dueDate, finalInvoice));
    }

    const changed = Object.values(patch).some((v) => v !== undefined);
    if (!changed) return detailViewOf(this.repo, current);
    const updated = await guarded(() => this.repo.update(id, patch, now));
    return detailViewOf(this.repo, updated);
  }
}
