import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * DX-042 (DB-011): el nombre de un insumo es único por SEDE y sin distinguir
 * mayúsculas, solo entre vivos (índice de expresión
 * `inventory_items_tenant_location_name_key`). Es el único índice único de
 * `inventory_items` que un alta o un cambio de nombre pueden violar, y bajo el
 * rol de la app Prisma no lo nombra en el P2002 (`target` "(not available)"),
 * así que se traduce aquí a un 409 con mensaje propio; cualquier otro error
 * sigue su camino.
 */
export const INVENTORY_NAME_TAKEN =
  'Ya existe un insumo con ese nombre en esta sede.';

export function toInventoryNameConflict(error: unknown): unknown {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    return new ConflictException(INVENTORY_NAME_TAKEN);
  }
  return error;
}
