import { AppLogger } from './app-logger';
import { requestContext } from './request-context';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id';

/**
 * Lo que el middleware lee de la petición (Express). `route`, `tenantHost` y
 * `user` los rellenan después el router, TenantHostMiddleware y JwtAuthGuard;
 * por eso la línea de acceso se compone al CERRAR la respuesta.
 */
export interface ObservedRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  baseUrl: string;
  url?: string;
  body?: unknown;
  route?: { path: unknown };
  tenantHost?: { host?: string; tenantId: string | null };
  user?: { sub: string };
}

export interface ObservedResponse {
  statusCode: number;
  writableFinished: boolean;
  setHeader(name: string, value: string): unknown;
  once(event: 'close', listener: () => void): unknown;
}

/**
 * Ruta PLANTILLA (`/api/v1/patients/:id`), nunca la URL real: la URL lleva
 * ids, documentos o la búsqueda (`?query=Juan`), que son datos del paciente.
 * `null` si ninguna ruta casó (404, CORS, cuerpo inválido...).
 */
export function routeTemplate(req: ObservedRequest): string | null {
  const path = req.route?.path;
  return typeof path === 'string' ? `${req.baseUrl}${path}` : null;
}

/**
 * Campos de la línea de acceso (DX-023). Lista CERRADA a propósito: ni cuerpo,
 * ni query, ni cabeceras, ni nombres; solo identificadores técnicos.
 */
export function accessLogFields(
  req: ObservedRequest,
  res: Pick<ObservedResponse, 'statusCode' | 'writableFinished'>,
  durationMs: number,
): Record<string, unknown> {
  return {
    method: req.method,
    route: routeTemplate(req),
    status: res.statusCode,
    durationMs,
    tenantId: req.tenantHost?.tenantId ?? null,
    userId: req.user?.sub ?? null,
    ...(res.writableFinished ? {} : { aborted: true }),
  };
}

/** Nanosegundos → milisegundos con 3 decimales. */
const toMs = (ns: bigint): number => Math.round(Number(ns) / 1000) / 1000;

/**
 * Primer middleware de la app (ver applyObservability): fija el request id
 * (el válido del cliente o uno nuevo), lo devuelve en `X-Request-Id` (también
 * en los 403 de CORS o los 413 del parser, que cortan antes del router), abre
 * el contexto de la petición para que todo el log lo lleve y, al cerrarse la
 * respuesta, escribe una línea de acceso.
 */
export function requestObservabilityMiddleware(
  logger: AppLogger,
  clock: () => bigint = () => process.hrtime.bigint(),
) {
  return (
    req: ObservedRequest,
    res: ObservedResponse,
    next: () => void,
  ): void => {
    const requestId = resolveRequestId(req.headers['x-request-id']);
    const startedAt = clock();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    // 'close' llega una vez, tanto si la respuesta terminó como si el cliente
    // cortó antes (entonces `aborted`). Se emite fuera del contexto async de
    // la petición, así que la línea se escribe dentro de uno propio.
    res.once('close', () => {
      requestContext.run({ requestId }, () => {
        logger.entry(
          'info',
          'Access',
          `${req.method} ${routeTemplate(req) ?? '-'} ${res.statusCode}`,
          accessLogFields(req, res, toMs(clock() - startedAt)),
        );
      });
    });
    requestContext.run({ requestId }, next);
  };
}
