import { ClinicRole, ExtraPermission } from '@prisma/client';

/**
 * DX-090: permisos extra por membresía. Un ADMIN se los concede a un miembro
 * además de su rol base, para clínicas sin recepcionista (la asistente cobra).
 * Catálogo CERRADO (el enum de la BD): añadir uno es una decisión de producto.
 *
 * - `PAYMENT_REGISTER`: registrar abonos y operar su turno de caja como
 *   RECEPTION (abrir, cerrar, cobrar). NO anula abonos.
 * - `FINANCIAL_REPORTS_VIEW`: ver los reportes financieros y la caja en
 *   lectura.
 */
export const EXTRA_PERMISSIONS: readonly ExtraPermission[] = [
  ExtraPermission.PAYMENT_REGISTER,
  ExtraPermission.FINANCIAL_REPORTS_VIEW,
];

/**
 * Lo que cada rol ya puede hacer de serie, en términos de este catálogo. Solo
 * sirve para DESCRIBIR (`effectivePermissions` de `GET /me`, lo que pinta la
 * web): las rutas siguen decidiendo por su `@Roles(...)` y, si lo declaran, por
 * el permiso EXTRA concedido (nunca por esta tabla).
 *
 * RECEPTION cobra y opera su caja (PAYMENT_ROLES, CASH_SESSION_ROLES), pero no
 * ve los reportes financieros de la clínica (REPORT_ROLES es solo ADMIN).
 */
const ROLE_BASE_PERMISSIONS: Record<ClinicRole, readonly ExtraPermission[]> = {
  [ClinicRole.ADMIN]: EXTRA_PERMISSIONS,
  [ClinicRole.RECEPTION]: [ExtraPermission.PAYMENT_REGISTER],
  [ClinicRole.DENTIST]: [],
  [ClinicRole.ASSISTANT]: [],
};

/** Los permisos del catálogo que tiene `role` sin concesión. */
export function roleBasePermissions(
  role: ClinicRole,
): readonly ExtraPermission[] {
  return ROLE_BASE_PERMISSIONS[role];
}

/**
 * Rol base ∪ permisos extra concedidos, sin duplicados y en el orden del
 * catálogo (estable para comparar y para la web).
 */
export function effectivePermissions(
  role: ClinicRole,
  extra: readonly ExtraPermission[],
): ExtraPermission[] {
  const held = new Set<ExtraPermission>([
    ...roleBasePermissions(role),
    ...extra,
  ]);
  return EXTRA_PERMISSIONS.filter((p) => held.has(p));
}

/** Quita duplicados y deja el orden del catálogo. */
export function normalizeExtraPermissions(
  permissions: readonly ExtraPermission[],
): ExtraPermission[] {
  const set = new Set(permissions);
  return EXTRA_PERMISSIONS.filter((p) => set.has(p));
}
