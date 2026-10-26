/** Categoría propia de la clínica (las predefinidas no son filas). */
export interface ExpenseCategory {
  id: string;
  name: string;
  active: boolean;
  createdAt: Date;
}
