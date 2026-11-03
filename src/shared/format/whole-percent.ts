/** Fracción → % entero (0,8 → 80). No es dinero: el dinero va en `shared/money`. */
export function wholePercent(fraction: number): number {
  return Math.round(fraction * 100);
}
