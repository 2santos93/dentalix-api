import {
  decodeBase32,
  TOTP_PERIOD_SECONDS,
  totpCode,
  totpStep,
} from '../../src/shared/crypto/totp';

/**
 * Los tests hacen de «app de autenticación» (DX-552). La API acepta el paso
 * actual ±1 (`TOTP_WINDOW`) y nunca un paso ya usado (`lastUsedStep`), con
 * `Date.now()` como reloj. Un código calculado con un desfase vale desde que
 * se calcula hasta el FINAL del paso `actual + desfase + 1`:
 *
 *  - desfase 0 o +1: al menos 30 s (60 s con +1). Aguanta que la petición
 *    llegue al servidor ya en el paso siguiente.
 *  - desfase −1: solo lo que quede del paso actual. Si el test lo calcula a
 *    las …:29.9 y el servidor lo valida a las …:30.1, ya está fuera (CI:
 *    role-matrix con 400 en `enrollPlatformAdmin`, break-glass con 401).
 *
 * Por eso aquí vive el ÚNICO generador de los e2e (lo vigila
 * test/invariants/totp-test-codes.spec.ts) y el código del paso anterior solo
 * se obtiene con `previousStepCode`, que antes de calcularlo se asegura de que
 * al paso actual le queda margen; si no, espera al inicio del siguiente
 * leyendo el reloj (no una pausa fija ni un reintento).
 */

export const TOTP_PERIOD_MS = TOTP_PERIOD_SECONDS * 1000;

/**
 * Margen mínimo que debe quedarle al paso actual para mandar un código del
 * paso anterior: de sobra para una petición en proceso (supertest), incluso
 * con el runner de CI cargado.
 */
export const PREVIOUS_STEP_MARGIN_MS = 5_000;

export interface TotpClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: TotpClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Paso TOTP (contador de 30 s) de ahora. */
export function currentTotpStep(nowMs = Date.now()): number {
  return totpStep(nowMs);
}

/** Código del paso actual + `offsetSteps` (offset 0 y +1: ver arriba). */
export function totpAt(
  secret: string,
  offsetSteps = 0,
  nowMs = Date.now(),
): string {
  return totpCode(decodeBase32(secret), totpStep(nowMs) + offsetSteps);
}

/** Milisegundos que le quedan al paso de `nowMs`. */
export function msLeftInStep(nowMs: number): number {
  return TOTP_PERIOD_MS - (nowMs % TOTP_PERIOD_MS);
}

/**
 * Vuelve cuando al paso actual le quedan al menos `marginMs`: o ya es así, o
 * espera justo lo que falta para el siguiente paso (se vuelve a leer el reloj
 * al despertar, por si el temporizador vence antes que el reloj de pared).
 * Devuelve el instante en que se puede calcular el código.
 */
export async function untilStepMargin(
  marginMs = PREVIOUS_STEP_MARGIN_MS,
  clock: TotpClock = realClock,
): Promise<number> {
  if (marginMs >= TOTP_PERIOD_MS) {
    throw new Error(`untilStepMargin: margen ${marginMs} ms ≥ un paso`);
  }
  let now = clock.now();
  while (msLeftInStep(now) < marginMs) {
    await clock.sleep(msLeftInStep(now));
    now = clock.now();
  }
  return now;
}

/**
 * Código del paso ANTERIOR, válido aún al menos `marginMs`. Para dejar libres
 * el paso actual y el siguiente a quien llama (anti-reuso): el alta del
 * superadmin lo usa para que el resto del test entre con `totpAt(secret)`.
 * Calcúlalo justo antes de mandar la petición.
 */
export async function previousStepCode(
  secret: string,
  marginMs = PREVIOUS_STEP_MARGIN_MS,
  clock: TotpClock = realClock,
): Promise<string> {
  const now = await untilStepMargin(marginMs, clock);
  return totpAt(secret, -1, now);
}
