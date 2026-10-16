/**
 * DX-085: la precarga de tipos de cambio no hace nada sin EXCHANGE_APP_ID, y
 * ConfigModule.forRoot fija el entorno validado al IMPORTAR AppModule. Un
 * spec que quiera probar la precarga importa este módulo ANTES que AppModule
 * (el proveedor se sustituye por uno falso: nunca sale a la red) y lo
 * restaura al terminar, porque las suites comparten `process.env`.
 */
const previous = process.env.EXCHANGE_APP_ID;
process.env.EXCHANGE_APP_ID = 'solo-test-app-id';

export function restoreExchangeAppId(): void {
  if (previous === undefined) {
    delete process.env.EXCHANGE_APP_ID;
  } else {
    process.env.EXCHANGE_APP_ID = previous;
  }
}
