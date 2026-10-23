import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EXPENSE_NOT_FOUND_MESSAGE } from '../../domain/expense-rules';
import {
  EXPENSE_REPOSITORY,
  type ExpenseRepository,
} from '../../domain/ports/expense-repository.port';
import { EXPENSE_CLOCK, type ExpenseClock } from '../expense-tokens';
import { type ExpenseDetailView, detailViewOf } from '../expense-view';

@Injectable()
export class GetExpenseUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly repo: ExpenseRepository,
    @Inject(EXPENSE_CLOCK) private readonly clock: ExpenseClock,
  ) {}

  /** 404 si no existe, es de otra clínica o de una sede que el usuario no ve. */
  async execute(id: string): Promise<ExpenseDetailView> {
    const detail = await this.repo.findById(id, this.clock());
    if (!detail) throw new NotFoundException(EXPENSE_NOT_FOUND_MESSAGE);
    return detailViewOf(this.repo, detail);
  }
}
