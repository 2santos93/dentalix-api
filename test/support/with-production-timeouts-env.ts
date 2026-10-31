/**
 * DX-431: plazos de producción BAJOS para el e2e de timeouts. ConfigModule
 * valida y fija el entorno al IMPORTAR AppModule, así que el spec importa este
 * módulo ANTES que nada de la app, y lo restaura al terminar porque las suites
 * comparten `process.env`.
 */
export const E2E_PRODUCTION_TIMEOUTS = {
  HTTP_KEEP_ALIVE_TIMEOUT_MS: '1000',
  HTTP_HEADERS_TIMEOUT_MS: '1500',
  HTTP_REQUEST_TIMEOUT_MS: '2000',
  TENANT_TX_TIMEOUT_MS: '500',
} as const;

const previous = Object.fromEntries(
  Object.keys(E2E_PRODUCTION_TIMEOUTS).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, E2E_PRODUCTION_TIMEOUTS);

export function restoreProductionTimeoutsEnv(): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
