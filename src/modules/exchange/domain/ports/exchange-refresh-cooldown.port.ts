export const EXCHANGE_REFRESH_COOLDOWN = Symbol('EXCHANGE_REFRESH_COOLDOWN');

/** DX-586: «Actualizar tasa», una vez cada 5 minutos por clínica. */
export const EXCHANGE_REFRESH_COOLDOWN_SECONDS = 5 * 60;

export type RefreshClaim =
  | { ok: true }
  /** Ya se pidió hace menos de 5 min: los segundos que faltan (≥ 1). */
  | { ok: false; retryAfterSeconds: number };

/**
 * DX-586: el turno de «Actualizar tasa» de la clínica del contexto, en la BD
 * (`tenants."exchangeRateRefreshedAt"`, hora de la BD): vale para todas las
 * réplicas y para todos los usuarios de la clínica.
 */
export interface ExchangeRefreshCooldown {
  /**
   * Toma el turno si la última petición fue hace `cooldownSeconds` o más (o
   * nunca), de forma atómica: de dos a la vez, solo una lo consigue.
   */
  claim(cooldownSeconds: number): Promise<RefreshClaim>;
}
