import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * Inactividad tras la que la API cierra una conexión keep-alive (DX-284).
 *
 * Por defecto Node la cierra a los 5 s (+1 s de margen), justo lo que aguanta
 * el `http.globalAgent` del cliente (5 s). El proxy `/api/v1` de la web
 * (Next) usa ese agente: si su bucle de eventos se para algo más de un
 * segundo al vencer el plazo, reutiliza una conexión que la API ya cerró y la
 * petición acaba en ECONNRESET, que Next devuelve como 500. Con 65 s el
 * cliente siempre suelta la conexión antes que el servidor (y también es más
 * que los 60 s de inactividad típicos de un balanceador delante de la API).
 */
export const API_KEEP_ALIVE_TIMEOUT_MS = 65_000;
/** Debe superar el keep-alive (si no, Node corta una conexión reutilizada). */
export const API_HEADERS_TIMEOUT_MS = 66_000;

export function applyHttpKeepAlive(server: Server): void {
  server.keepAliveTimeout = API_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = API_HEADERS_TIMEOUT_MS;
}

/** Lo aplica al servidor HTTP de la app (main.ts y los e2e, vía configureApp). */
export function applyAppHttpKeepAlive(app: INestApplication): void {
  applyHttpKeepAlive(app.getHttpServer() as Server);
}
