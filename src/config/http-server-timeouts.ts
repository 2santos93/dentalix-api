import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Server } from 'node:http';
import {
  boundedInt,
  loadUploadTimeouts,
} from '../shared/storage/storage-config';

/**
 * Plazos del servidor HTTP de la API (DX-284, DX-431), configurables por
 * entorno y validados al arrancar (`validateEnv`):
 *
 * - `HTTP_KEEP_ALIVE_TIMEOUT_MS` (65 s): inactividad tras la que la API
 *   cierra una conexión keep-alive. Por defecto Node la cierra a los 5 s
 *   (+1 s de margen), justo lo que aguanta el `http.globalAgent` del cliente
 *   (5 s). El proxy `/api/v1` de la web (Next) usa ese agente: si su bucle de
 *   eventos se para algo más de un segundo al vencer el plazo, reutiliza una
 *   conexión que la API ya cerró y la petición acaba en ECONNRESET, que Next
 *   devuelve como 500. Tiene que ser MAYOR que la inactividad del balanceador
 *   hacia la API (60 s típicos): el cliente siempre suelta antes.
 * - `HTTP_HEADERS_TIMEOUT_MS` (keep-alive + 1 s): plazo para recibir las
 *   cabeceras. Mayor que el keep-alive, o Node corta una conexión reutilizada.
 * - `HTTP_REQUEST_TIMEOUT_MS` (130 s): plazo para recibir la petición ENTERA
 *   (cabeceras y cuerpo); vencido, Node responde 408 y cierra. Corta a los
 *   clientes lentos (slowloris). En producción, mayor que
 *   `UPLOAD_MAX_DURATION_MS` (120 s), para que una subida lenta reciba antes
 *   el error propio de la subida (DX-259). No acota lo que tarda la API en
 *   responder: eso lo acotan `TENANT_TX_TIMEOUT_MS` y el `statement_timeout`.
 */
export interface HttpServerTimeouts {
  keepAliveTimeoutMs: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
}

export const DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS = 65_000;
/** Sin `HTTP_HEADERS_TIMEOUT_MS`: el keep-alive más esto. */
export const HEADERS_OVER_KEEP_ALIVE_MS = 1_000;
export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 130_000;

export const HTTP_TIMEOUT_LIMITS = {
  HTTP_KEEP_ALIVE_TIMEOUT_MS: [1_000, 600_000],
  HTTP_HEADERS_TIMEOUT_MS: [1_000, 600_000],
  HTTP_REQUEST_TIMEOUT_MS: [1_000, 3_600_000],
} as const satisfies Record<string, readonly [number, number]>;

type HttpTimeoutKey = keyof typeof HTTP_TIMEOUT_LIMITS;
type Get = (key: string) => string | undefined;

/** Lo que Node usa por defecto para revisar los plazos de las conexiones. */
const NODE_CONNECTIONS_CHECKING_INTERVAL_MS = 30_000;
const MIN_CONNECTIONS_CHECKING_INTERVAL_MS = 100;

const valueOf = (get: Get, key: HttpTimeoutKey): number | null =>
  boundedInt(get(key), HTTP_TIMEOUT_LIMITS[key]);

export function loadHttpServerTimeouts(get: Get): HttpServerTimeouts {
  const keepAliveTimeoutMs =
    valueOf(get, 'HTTP_KEEP_ALIVE_TIMEOUT_MS') ??
    DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS;
  return {
    keepAliveTimeoutMs,
    headersTimeoutMs:
      valueOf(get, 'HTTP_HEADERS_TIMEOUT_MS') ??
      keepAliveTimeoutMs + HEADERS_OVER_KEEP_ALIVE_MS,
    requestTimeoutMs:
      valueOf(get, 'HTTP_REQUEST_TIMEOUT_MS') ??
      DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  };
}

/** Problemas de configuración para `validateEnv` (la API no arranca con ellos). */
export function httpServerTimeoutProblems(get: Get, isProd: boolean): string[] {
  const problems: string[] = [];
  for (const [key, [min, max]] of Object.entries(HTTP_TIMEOUT_LIMITS)) {
    const raw = get(key);
    if (raw == null || raw.trim() === '') continue;
    if (valueOf(get, key as HttpTimeoutKey) === null) {
      problems.push(`${key} debe ser un entero entre ${min} y ${max} (ms).`);
    }
  }
  // Las relaciones solo se comprueban con valores válidos: si no, repetirían
  // el mismo problema con otras palabras.
  if (problems.length > 0) return problems;

  const t = loadHttpServerTimeouts(get);
  if (t.headersTimeoutMs <= t.keepAliveTimeoutMs) {
    problems.push(
      `HTTP_HEADERS_TIMEOUT_MS (${t.headersTimeoutMs}) debe ser mayor que HTTP_KEEP_ALIVE_TIMEOUT_MS (${t.keepAliveTimeoutMs}): si no, Node corta conexiones keep-alive que el cliente reutiliza.`,
    );
  }
  if (t.requestTimeoutMs < t.headersTimeoutMs) {
    problems.push(
      `HTTP_REQUEST_TIMEOUT_MS (${t.requestTimeoutMs}) debe ser mayor o igual que HTTP_HEADERS_TIMEOUT_MS (${t.headersTimeoutMs}): la petición entera incluye sus cabeceras.`,
    );
  }
  const uploadMaxMs = loadUploadTimeouts(get).maxDurationMs;
  if (isProd && t.requestTimeoutMs <= uploadMaxMs) {
    problems.push(
      `HTTP_REQUEST_TIMEOUT_MS (${t.requestTimeoutMs}) debe ser mayor que UPLOAD_MAX_DURATION_MS (${uploadMaxMs}) en producción: si no, una subida lenta acaba en un 408 sin explicación en vez del error de la subida.`,
    );
  }
  return problems;
}

/**
 * Cada cuánto revisa Node los plazos de cabeceras y petición: una décima
 * parte del menor (entre 100 ms y los 30 s que usa Node por defecto). Con los
 * 30 s de Node, un `requestTimeout` de 2 s cortaría hasta 32 s después.
 */
export function connectionsCheckingIntervalMs(t: HttpServerTimeouts): number {
  const tenth = Math.floor(
    Math.min(t.headersTimeoutMs, t.requestTimeoutMs) / 10,
  );
  return Math.min(
    NODE_CONNECTIONS_CHECKING_INTERVAL_MS,
    Math.max(MIN_CONNECTIONS_CHECKING_INTERVAL_MS, tenth),
  );
}

/**
 * Antes de `listen`: Node arma la revisión periódica de las conexiones al
 * empezar a escuchar, con el `connectionsCheckingInterval` de ese momento.
 */
export function applyHttpServerTimeouts(
  server: Server,
  t: HttpServerTimeouts,
): void {
  server.keepAliveTimeout = t.keepAliveTimeoutMs;
  server.headersTimeout = t.headersTimeoutMs;
  server.requestTimeout = t.requestTimeoutMs;
  (
    server as Server & { connectionsCheckingInterval: number }
  ).connectionsCheckingInterval = connectionsCheckingIntervalMs(t);
}

/** Lo aplica al servidor HTTP de la app (main.ts y los e2e, vía configureApp). */
export function applyAppHttpServerTimeouts(app: INestApplication): void {
  const config = app.get(ConfigService);
  applyHttpServerTimeouts(
    app.getHttpServer() as Server,
    loadHttpServerTimeouts((key) => config.get<string>(key)),
  );
}
