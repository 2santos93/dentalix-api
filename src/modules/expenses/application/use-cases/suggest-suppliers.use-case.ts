import { Inject, Injectable } from '@nestjs/common';
import {
  EXPENSE_REPOSITORY,
  type ExpenseRepository,
} from '../../domain/ports/expense-repository.port';

export const SUPPLIER_SUGGESTIONS_LIMIT = 20;
const MAX_QUERY = 100;

@Injectable()
export class SuggestSuppliersUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY) private readonly repo: ExpenseRepository,
  ) {}

  /**
   * Hasta 20 proveedores DISTINTOS ya usados en gastos (sin mayúsculas ni
   * tildes), el de uso más reciente primero. R4: no hay entidad proveedor;
   * son las sugerencias de un `<datalist>`.
   */
  async execute(query: string | undefined): Promise<string[]> {
    const suggestions = await this.repo.suppliers(
      (query ?? '').trim().slice(0, MAX_QUERY),
      SUPPLIER_SUGGESTIONS_LIMIT,
    );
    return suggestions.map((s) => s.name);
  }
}
