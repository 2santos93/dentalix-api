import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  CATEGORY_NAME_MAX,
  CATEGORY_NAME_MIN,
  CATEGORY_INVALID_MESSAGE,
} from '../domain/expense-rules';
import {
  categoryKey,
  matchLegacyPredefinedCategory,
  matchPredefinedCategory,
  normalizeCategoryName,
} from '../domain/expense-categories';
import {
  EXPENSE_CATEGORY_REPOSITORY,
  type ExpenseCategoryRepository,
} from '../domain/ports/expense-category-repository.port';

/**
 * «¿Esta categoría se puede poner en un gasto?» (R3): una predefinida, una
 * propia ACTIVA de la clínica o el nombre anterior de una predefinida
 * (DX-274-bis). Devuelve el nombre con su grafía canónica (la
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
    // DX-274-bis: el nombre anterior de una predefinida es la actual. Después
    // de las propias: una propia con ese nombre (solo posible por SQL; la API
    // la rechaza) sigue siendo suya.
    const legacy = matchLegacyPredefinedCategory(name);
    if (legacy) return legacy;
    throw new BadRequestException(CATEGORY_INVALID_MESSAGE);
  }
}
