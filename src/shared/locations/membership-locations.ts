import { Prisma } from '@prisma/client';

/**
 * DX-089: sedes asignadas a una membresía (`membership_locations`), con lo
 * necesario para saber si siguen activas. Orden por antigüedad de la sede
 * para que el claim `loc` sea estable entre emisiones. Única definición: la
 * usan login, refresh y la aceptación de invitaciones.
 */
export const MEMBERSHIP_LOCATIONS_SELECT = {
  select: {
    location: { select: { id: true, isActive: true, deletedAt: true } },
  },
  orderBy: { location: { createdAt: 'asc' } },
} satisfies Prisma.ClinicMembership$locationsArgs;

/**
 * Sin filas → `null` (todas las sedes). Con filas, solo las sedes activas y no
 * borradas; si ya no queda ninguna el resultado es `[]` (ninguna sede), nunca
 * "todas": desactivar la sede de un miembro restringido no puede ampliarle el
 * acceso.
 */
export function activeLocationIds(
  rows: {
    location: { id: string; isActive: boolean; deletedAt: Date | null };
  }[],
): string[] | null {
  if (rows.length === 0) return null;
  return rows
    .filter(({ location }) => location.isActive && !location.deletedAt)
    .map(({ location }) => location.id);
}
