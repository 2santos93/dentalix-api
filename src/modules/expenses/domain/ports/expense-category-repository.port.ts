import type { ExpenseCategory } from '../entities/expense-category.entity';

export const EXPENSE_CATEGORY_REPOSITORY = Symbol(
  'EXPENSE_CATEGORY_REPOSITORY',
);

export interface ExpenseCategoryRepository {
  /** Categorías propias vivas y activas, por nombre. */
  listActive(): Promise<ExpenseCategory[]>;

  /**
   * La categoría propia VIVA y ACTIVA cuyo nombre coincide sin mayúsculas ni
   * tildes (`categoryKey`), o null.
   */
  findActiveByKey(key: string): Promise<ExpenseCategory | null>;

  /** Cualquier categoría propia viva (activa o no) con esa clave. */
  findLiveByKey(key: string): Promise<ExpenseCategory | null>;

  /** Alta; el único parcial de la BD cierra la carrera (→ `null`). */
  create(name: string, createdById: string): Promise<ExpenseCategory | null>;

  /** Retiro lógico (`deletedAt` y `active = false`); false si no existe. */
  retire(id: string): Promise<boolean>;
}
