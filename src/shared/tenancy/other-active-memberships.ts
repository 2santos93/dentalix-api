import type { Prisma } from '@prisma/client';

/**
 * DX-143 (SEC-033): `clinic_memberships` está bajo RLS por clínica; la
 * función SECURITY DEFINER (migración 20261017231000) mira todas y devuelve
 * solo si hay alguna activa fuera de `tenantId` (un booleano: ni cuál ni
 * cuántas). La usan invitaciones (DX-143) y el desbloqueo del login (DX-213).
 */
export async function otherActiveMemberships(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const [row] = await db.$queryRaw<{ other: boolean }[]>`
    SELECT public.dx_user_has_other_active_memberships(${userId}::uuid, ${tenantId}::uuid) AS other`;
  return row?.other === true;
}
