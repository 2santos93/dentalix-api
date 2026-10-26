import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  CATEGORY_NAME_MAX,
  CATEGORY_NAME_MIN,
  CATEGORY_INVALID_MESSAGE,
} from '../domain/expense-rules';
import {
  categoryKey,
  matchPredefinedCategory,
  normalizeCategoryName,
} from '../domain/expense-categories';
import {
  EXPENSE_CATEGORY_REPOSITORY,
  type ExpenseCategoryRepository,
} from '../domain/ports/expense-category-repository.port';

/**
 * «¿Esta categoría se puede poner en un gasto?» (R3): una predefinida o una
 * propia ACTIVA de la clínica. Devuelve el nombre con su grafía canónica (la
 * foto que se guarda en el gasto).
 */
@Injectable()
export class ExpenseCategoryResolver {
  constructor(
    @Inject(EXPENSE_CATEGORY_REPOSITORY)
    private readonly categories: ExpenseCategoryRepository,
  ) {}

  async resolve(raw: string): Promise<string> {
    const name = normalizeCategoryName(raw ?? '');
    const length = Array.from(name).length;
    if (length < CATEGORY_NAME_MIN || length > CATEGORY_NAME_MAX) {
      throw new BadRequestException(CATEGORY_INVALID_MESSAGE);
    }
    const predefined = matchPredefinedCategory(name);
    if (predefined) return predefined;
    const custom = await this.categories.findActiveByKey(categoryKey(name));
    if (custom) return custom.name;
    throw new BadRequestException(CATEGORY_INVALID_MESSAGE);
  }
}
