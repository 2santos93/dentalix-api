import type { Prisma, PrismaClient } from '@prisma/client';

/** Ids de los tipos de recall por defecto de una clínica (DX-015-bis). */
export interface DefaultRecallTypes {
  HYGIENE: string;
  CHECKUP: string;
  /** «Mantenimiento periodontal» (sin clave del enum). */
  PERIO: string;
}

/**
 * DX-015-bis: siembra los tipos por defecto de una clínica creada a mano en un
 * test (las del alta ya los traen) con la MISMA función que el alta y la
 * migración, y devuelve sus ids. Con los disparadores, si el catálogo de la
 * clínica ya tiene esos procedimientos. Bajo la clínica en la sesión (vale
 * también con un owner sujeto a la RLS).
 */
export async function seedDefaultRecallTypes(
  raw: PrismaClient<Prisma.PrismaClientOptions>,
  tenantId: string,
): Promise<DefaultRecallTypes> {
  return raw.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    await tx.$executeRaw`SELECT public.dx_recall_seed_default_types(${tenantId}::uuid)`;
    return recallTypesOf(tx, tenantId);
  });
}

/** Los ids de los tipos por defecto de una clínica que ya los tiene. */
export async function recallTypesOf(
  db: Prisma.TransactionClient | PrismaClient<Prisma.PrismaClientOptions>,
  tenantId: string,
): Promise<DefaultRecallTypes> {
  const rows = await db.recallType.findMany({
    where: { tenantId, deletedAt: null },
    select: { id: true, systemKey: true, name: true },
  });
  const find = (pick: (r: (typeof rows)[number]) => boolean) => {
    const row = rows.find(pick);
    if (!row) throw new Error(`Faltan los tipos de recall de ${tenantId}`);
    return row.id;
  };
  return {
    HYGIENE: find((r) => r.systemKey === 'HYGIENE'),
    CHECKUP: find((r) => r.systemKey === 'CHECKUP'),
    PERIO: find((r) => r.name === 'Mantenimiento periodontal'),
  };
}
