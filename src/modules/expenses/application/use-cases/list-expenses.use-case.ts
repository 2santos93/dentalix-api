import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type {
  ExpenseListFilters,
  ExpenseStatusFilter,
} from '../../domain/ports/expense-repository.port';
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
/** Tope de filas de una exportación; más obliga a acotar el periodo. */
export const EXPORT_MAX_ROWS = 10_000;
export const EXPORT_TOO_MANY_MESSAGE = `Hay más de ${EXPORT_MAX_ROWS} gastos con esos filtros: acota el periodo para exportarlos.`;

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

export interface ExpenseExportView {
  items: ExpenseView[];
  /** Nombre de cada sede de la clínica. */
  locationNames: Map<string, string>;
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

  /** Filtros validados y normalizados, sin paginar. */
  private filtersOf(
    input: ListExpensesInput,
  ): Omit<ExpenseListFilters, 'page' | 'pageSize'> {
    const from = input.from === undefined ? undefined : parseDay(input.from);
    const to = input.to === undefined ? undefined : parseDay(input.to);
    if (from === null || to === null) {
      throw new BadRequestException(FILTER_DATE_MESSAGE);
    }
    if (from && to && from > to) throw new BadRequestException(RANGE_MESSAGE);
    const query = input.query?.trim().slice(0, MAX_QUERY_LENGTH);
    return {
      from,
      to,
      locationId: input.locationId,
      category: input.category?.trim() || undefined,
      status: input.status,
      overdue: input.overdue,
      query: query || undefined,
    };
  }

  /** Más reciente primero (fecha de factura); respeta las sedes del usuario. */
  async execute(input: ListExpensesInput): Promise<ExpensePageView> {
    const page = await this.repo.list(
      {
        ...this.filtersOf(input),
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

  /** Todos los gastos del filtro (CSV), hasta `EXPORT_MAX_ROWS`. */
  async exportAll(input: ListExpensesInput): Promise<ExpenseExportView> {
    const page = await this.repo.list(
      {
        ...this.filtersOf(input),
        page: 1,
        pageSize: EXPORT_MAX_ROWS + 1,
      },
      this.clock(),
      false,
    );
    if (page.items.length > EXPORT_MAX_ROWS) {
      throw new BadRequestException(EXPORT_TOO_MANY_MESSAGE);
    }
    return {
      items: await viewsOf(this.repo, page.items),
      locationNames: await this.repo.locationNames(),
    };
  }
}
