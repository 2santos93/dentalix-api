import { randomBytes } from 'node:crypto';

/**
 * UUID versión 7 (RFC 9562): 48 bits de milisegundos y 74 aleatorios. Los
 * ids de envíos y entregas los genera la app (el esquema declara `uuid(7)`):
 * ordenados por creación, como los de Prisma.
 */
export function uuidV7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // versión 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
