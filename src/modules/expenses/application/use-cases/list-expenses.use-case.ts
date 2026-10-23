import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ExpenseStatusFilter } from '../../domain/ports/expense-repository.port';
import { parseDay } from '../../domain/expense-rules';
import {
  EXPENSE_REPOSITORY,
  type ExpenseRepository,
} from '../../domain/ports/expense-repository.port';
import { EXPENSE_CLOCK, type ExpenseClock } from '../expense-tokens';
import { type ExpenseView, viewsOf } from '../expense-view';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
export const MAX_QUERY_LENGTH = 100;
export const RANGE_MESSAGE =
  'La fecha «desde» no puede ser posterior a «hasta».';
export const FILTER_DATE_MESSAGE = 'La fecha del filtro no es válida.';

export interface ListExpensesInput {
  from?: string;
  to?: string;
  locationId?: string;
  category?: string;
  status?: ExpenseStatusFilter;
  overdue?: boolean;
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface ExpensePageView {
  items: ExpenseView[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class ListExpensesUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly repo: ExpenseRepository,
    @Inject(EXPENSE_CLOCK) private readonly clock: ExpenseClock,
  ) {}

  /** Más reciente primero (fecha de factura); respeta las sedes del usuario. */
  async execute(input: ListExpensesInput): Promise<ExpensePageView> {
    const from = input.from === undefined ? undefined : parseDay(input.from);
    const to = input.to === undefined ? undefined : parseDay(input.to);
    if (from === null || to === null) {
      throw new BadRequestException(FILTER_DATE_MESSAGE);
    }
    if (from && to && from > to) throw new BadRequestException(RANGE_MESSAGE);
    const query = input.query?.trim().slice(0, MAX_QUERY_LENGTH);
    const page = await this.repo.list(
      {
        from,
        to,
        locationId: input.locationId,
        category: input.category?.trim() || undefined,
        status: input.status,
        overdue: input.overdue,
        query: query || undefined,
        page: Math.max(input.page ?? 1, 1),
        pageSize: Math.min(
          Math.max(input.pageSize ?? DEFAULT_PAGE_SIZE, 1),
          MAX_PAGE_SIZE,
        ),
      },
      this.clock(),
    );
    return { ...page, items: await viewsOf(this.repo, page.items) };
  }
}
