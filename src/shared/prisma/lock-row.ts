import { Prisma } from '@prisma/client';

/** Tablas cuyo «antes» se lee bloqueado en una edición auditada (DX-360). */
const LOCKABLE_TABLES = [
  'appointment_types',
  'consent_templates',
  'inventory_items',
  'location_schedules',
  'locations',
  'payers',
  // DX-516: el medio serializa el alta y el cambio de sus ajustes.
  'payment_methods',
  'prescription_templates',
] as const;

export type LockableTable = (typeof LOCKABLE_TABLES)[number];

/**
 * `SELECT … FOR UPDATE` de una fila por id dentro de `tx` (bajo la RLS de la
 * transacción): el «antes» que se lee después es el que de verdad va a
 * cambiar, porque otra edición de la misma fila espera a que esta confirme y
 * lee su después (DX-360). `FOR NO KEY UPDATE` para una fila que solo
 * serializa la edición de otra tabla (la sede de unos ajustes de
 * recordatorio) sin bloquear a quien la referencia por FK. `false` si la fila
 * no existe o no es de esta clínica. La tabla sale de una lista cerrada,
 * nunca de un dato del cliente.
 */
export async function lockRow(
  tx: Prisma.TransactionClient,
  table: LockableTable,
  id: string,
  strength: 'UPDATE' | 'NO KEY UPDATE' = 'UPDATE',
): Promise<boolean> {
  if (!LOCKABLE_TABLES.includes(table)) {
    throw new Error(`Tabla no bloqueable: ${table}`);
  }
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM ${Prisma.raw(`"${table}"`)}
     WHERE "id" = ${id}::uuid
       FOR ${Prisma.raw(strength === 'UPDATE' ? 'UPDATE' : 'NO KEY UPDATE')}`;
  return rows.length > 0;
}
