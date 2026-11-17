import type { Prisma } from '@prisma/client';

/**
 * DX-205: un importe Decimal (precio del catálogo, `Decimal(12,2)`) como texto
 * canónico con 2 decimales, sin pasar por un `number`. Para huellas (SHA-256)
 * y para mandar precios a SQL como texto (`::numeric`). El valor ya está
 * redondeado a céntimos por quien lo calcula; si trae más, redondea a la
 * mitad hacia arriba (`toFixed` de decimal.js usa ROUND_HALF_UP por defecto).
 */
export function decimalAmountText(value: Prisma.Decimal): string {
  return value.toFixed(2);
}
