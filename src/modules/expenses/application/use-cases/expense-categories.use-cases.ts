import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PREDEFINED_EXPENSE_CATEGORIES,
  categoryKey,
  matchPredefinedCategory,
} from '../../domain/expense-categories';
import {
  CATEGORY_DUPLICATE_MESSAGE,
  CATEGORY_NOT_FOUND_MESSAGE,
  validateCategoryName,
} from '../../domain/expense-rules';
import {
  EXPENSE_CATEGORY_REPOSITORY,
  type ExpenseCategoryRepository,
} from '../../domain/ports/expense-category-repository.port';
import { rule } from '../guarded';

/** Lo que ve el selector: predefinidas (`id: null`) y propias activas. */
export interface ExpenseCategoryView {
  id: string | null;
  name: string;
  predefined: boolean;
}

@Injectable()
export class ListExpenseCategoriesUseCase {
  constructor(
    @Inject(EXPENSE_CATEGORY_REPOSITORY)
    private readonly repo: ExpenseCategoryRepository,
  ) {}

  /** Las predefinidas en su orden y, después, las propias por nombre. */
  async execute(): Promise<ExpenseCategoryView[]> {
    const custom = await this.repo.listActive();
    return [
      ...PREDEFINED_EXPENSE_CATEGORIES.map((name) => ({
        id: null,
        name,
        predefined: true,
      })),
      ...custom.map((c) => ({ id: c.id, name: c.name, predefined: false })),
    ];
  }
}

@Injectable()
export class CreateExpenseCategoryUseCase {
  constructor(
    @Inject(EXPENSE_CATEGORY_REPOSITORY)
    private readonly repo: ExpenseCategoryRepository,
  ) {}

  /** 409 si ya existe (predefinida o propia), sin mayúsculas ni tildes. */
  async execute(
    rawName: string,
    createdById: string,
  ): Promise<ExpenseCategoryView> {
    const name = rule(() => validateCategoryName(rawName));
    if (
      matchPredefinedCategory(name) ||
      (await this.repo.findLiveByKey(categoryKey(name)))
    ) {
      throw new ConflictException(CATEGORY_DUPLICATE_MESSAGE);
    }
    const created = await this.repo.create(name, createdById);
    if (!created) throw new ConflictException(CATEGORY_DUPLICATE_MESSAGE);
    return { id: created.id, name: created.name, predefined: false };
  }
}

@Injectable()
export class DeleteExpenseCategoryUseCase {
  constructor(
    @Inject(EXPENSE_CATEGORY_REPOSITORY)
    private readonly repo: ExpenseCategoryRepository,
  ) {}

  /**
   * Retiro lógico: sale de los selectores, pero los gastos que la usan
   * conservan su nombre (R3: es una foto de texto).
   */
  async execute(id: string): Promise<void> {
    if (!(await this.repo.retire(id))) {
      throw new NotFoundException(CATEGORY_NOT_FOUND_MESSAGE);
    }
  }
}
