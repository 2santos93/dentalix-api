/**
 * DX-054: cuánto espera un saldo, EN TOTAL, a las conversiones en vivo de sus
 * abonos (las que piden tasas al proveedor). El proveedor corta a los 10 s
 * (`PROVIDER_TIMEOUT_MS`); el saldo no espera tanto: pasado este plazo los
 * abonos aún sin convertir salen «sin tasa» y no suman, y la respuesta llega
 * en menos de 5 s aunque el proveedor esté lento o colgado.
 */
export const BALANCE_CONVERSION_BUDGET_MS = 4_000;

/** Lo que devuelve `race` cuando el plazo venció antes que la conversión. */
export const CONVERSION_TIMED_OUT: unique symbol = Symbol(
  'CONVERSION_TIMED_OUT',
);

export interface ConversionDeadline {
  /** La conversión, o `CONVERSION_TIMED_OUT` si el plazo venció antes. */
  race<T>(work: Promise<T>): Promise<T | typeof CONVERSION_TIMED_OUT>;
  /** ¿Alguna conversión se quedó sin respuesta a tiempo? */
  readonly timedOut: boolean;
  /** Libera el temporizador (siempre, al terminar el cálculo). */
  dispose(): void;
}

/**
 * Un plazo compartido por todas las conversiones de UN cálculo. El
 * temporizador arranca con la primera conversión (sin conversiones en vivo no
 * hay temporizador) y, vencido, las siguientes responden al instante. Una
 * conversión abandonada sigue su curso; su resultado o su error se descartan
 * (`Promise.race` ya los atiende, así que nunca queda un rechazo sin manejar).
 */
export function conversionDeadline(
  budgetMs: number = BALANCE_CONVERSION_BUDGET_MS,
): ConversionDeadline {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let expired: Promise<typeof CONVERSION_TIMED_OUT> | null = null;
  let timedOut = false;

  const deadline = (): Promise<typeof CONVERSION_TIMED_OUT> => {
    expired ??= new Promise((resolve) => {
      timer = setTimeout(() => resolve(CONVERSION_TIMED_OUT), budgetMs);
      timer.unref?.();
    });
    return expired;
  };

  return {
    async race<T>(work: Promise<T>) {
      const result = await Promise.race([work, deadline()]);
      if (result === CONVERSION_TIMED_OUT) timedOut = true;
      return result;
    },
    get timedOut() {
      return timedOut;
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
