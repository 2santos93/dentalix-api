import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Un request id del cliente (balanceador, web) solo se respeta si es seguro
 * para el log: 8–128 caracteres de un alfabeto sin espacios, comillas ni
 * saltos de línea, así no puede inyectar líneas o campos falsos (DX-023).
 * Cubre UUID, ULID y los ids habituales de proxies (`lb-01:req.42`).
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function isValidRequestId(value: string): boolean {
  return SAFE_REQUEST_ID.test(value);
}

/** El id del cliente si es válido; si no (o no hay), un UUID nuevo. */
export function resolveRequestId(
  header: string | string[] | undefined,
): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate !== undefined && isValidRequestId(candidate)
    ? candidate
    : randomUUID();
}
