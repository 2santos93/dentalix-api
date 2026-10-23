import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * DX-259 (revisión M-1): presupuesto de tiempo compartido por TODAS las
 * operaciones del almacén de un caso de uso. `complete` hace hasta cinco
 * (HeadObject, 1–3 Range y CopyObject): con un plazo por operación, en el peor
 * caso se pasaría de los 30 s del `proxyTimeout` de la web y el navegador
 * vería un 500 en vez del 503 en español. Dentro de `withStorageBudget`, cada
 * operación vence a lo que quede del presupuesto si es menos que su plazo.
 */
const budgets = new AsyncLocalStorage<{ deadline: number }>();

/** Presupuesto de `complete` y de las subidas que pasan por la API: cabe en los 30 s del proxy de la web. */
export const UPLOAD_STORAGE_BUDGET_MS = 25_000;

export function withStorageBudget<T>(
  budgetMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const current = budgets.getStore();
  const deadline = Date.now() + budgetMs;
  // Un presupuesto anidado nunca alarga el de fuera.
  return budgets.run(
    { deadline: current ? Math.min(current.deadline, deadline) : deadline },
    fn,
  );
}

/** Milisegundos que le quedan al presupuesto en curso, o null si no hay. */
export function remainingStorageBudgetMs(): number | null {
  const current = budgets.getStore();
  return current ? Math.max(0, current.deadline - Date.now()) : null;
}
