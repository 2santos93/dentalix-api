/**
 * Polling con tope (DX-085): espera a que `condition` se cumpla comprobándola
 * cada `intervalMs`, y falla con `what` si no ocurre en `timeoutMs` (4 s por
 * defecto: por debajo de los 5 s de jest, así el error dice qué faltó). Para
 * los tests de concurrencia en lugar de `sleep` arbitrarios: no espera de más
 * cuando la condición ya se cumple y no cuelga el test cuando nunca se cumple.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  { timeoutMs = 4_000, intervalMs = 10 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: no ocurrió en ${timeoutMs} ms: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Promesa que se resuelve desde fuera (barrera entre dos tareas del test). */
export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  settled: () => boolean;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let done = false;
  const promise = new Promise<T>((r) => {
    resolve = (value: T) => {
      done = true;
      r(value);
    };
  });
  return { promise, resolve, settled: () => done };
}
