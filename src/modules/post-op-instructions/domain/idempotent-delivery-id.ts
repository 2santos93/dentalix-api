import { createHash } from 'node:crypto';

// Espacio de nombres fijo de los ids de entrega derivados (UUIDv5, RFC 4122).
const NAMESPACE = '6f2c1a52-8b1e-4d6f-9c52-2d5f0a7a9c10';

/**
 * DX-250: id de la entrega derivado de la `Idempotency-Key` del cliente
 * (UUIDv5 de `tenantId:appointmentId:key`). Repetir la petición (reintento tras
 * un 502 o un tiempo agotado, doble clic, otra pestaña) da el MISMO id: la
 * segunda inserción choca con la clave primaria y se devuelve la entrega ya
 * registrada. Llevar el tenant y la cita en el nombre impide que una clave
 * choque o filtre entre clínicas o citas.
 */
export function idempotentDeliveryId(
  tenantId: string,
  appointmentId: string,
  key: string,
): string {
  const hash = createHash('sha1')
    .update(Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex'))
    .update(`${tenantId}:${appointmentId}:${key.toLowerCase()}`)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
