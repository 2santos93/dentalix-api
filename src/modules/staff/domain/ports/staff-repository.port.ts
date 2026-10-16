import { ClinicRole } from '@prisma/client';
import { StaffMember } from '../entities/staff-member.entity';
import {
  StaffDirectoryPage,
  StaffDirectoryQuery,
} from '../entities/staff-directory-entry.entity';

export const STAFF_REPOSITORY = Symbol('STAFF_REPOSITORY');

/** Cambios de `PATCH /staff/:userId`; `professionalLicense: null` lo borra. */
export interface StaffPatch {
  fullName?: string;
  role?: ClinicRole;
  professionalLicense?: string | null;
}

/**
 * Resultado de una escritura que puede retirar un ADMIN. `NOT_FOUND`: no hay
 * membresía activa de ese usuario en la clínica. `LAST_ADMIN`: es el último
 * ADMIN activo y no se ha escrito nada.
 */
export type UpdateStaffOutcome =
  | { kind: 'UPDATED'; member: StaffMember }
  | { kind: 'NOT_FOUND' }
  | { kind: 'LAST_ADMIN' };

export type DeactivateStaffOutcome = 'DEACTIVATED' | 'NOT_FOUND' | 'LAST_ADMIN';

export interface StaffRepository {
  /**
   * Directorio paginado: miembros (activos y, si se piden, inactivos) más las
   * invitaciones vigentes, en una sola lista ordenada por nombre.
   * Tenant-scoped (via RLS / `runWithTenant`).
   */
  listDirectory(query: StaffDirectoryQuery): Promise<StaffDirectoryPage>;

  /**
   * Miembro por `userId` para la vista de perfil, **incluidos los
   * desactivados** — a diferencia de `findById`, que solo ve activos. El
   * perfil es justo donde se reactiva a alguien, así que tiene que poder
   * abrirse. Tenant-scoped (via RLS / `runWithTenant`).
   */
  findDetailById(
    userId: string,
  ): Promise<(StaffMember & { status: 'ACTIVE' | 'INACTIVE' }) | null>;

  /**
   * Reactiva la membresía desactivada de `userId` (limpia `deletedAt`).
   * Devuelve el miembro ya activo, o `null` si no había ninguna membresía
   * desactivada que reactivar. Tenant-scoped (via RLS / `runWithTenant`).
   */
  reactivateById(userId: string): Promise<StaffMember | null>;

  /**
   * Active clinic staff — non-deleted `ClinicMembership` rows joined to their
   * `User`, tenant-scoped (via RLS / `runWithTenant`), ordered by full name.
   */
  listActive(): Promise<StaffMember[]>;

  /**
   * Active staff member by `userId` for the current tenant, or `null` if no
   * matching non-deleted `ClinicMembership`/`User` exists. Tenant-scoped
   * (via RLS / `runWithTenant`).
   */
  findById(userId: string): Promise<StaffMember | null>;

  /**
   * Partially updates the staff member's `fullName` and/or `role` for the
   * current tenant. Tenant-scoped (via RLS / `runWithTenant`).
   *
   * Regla "siempre queda al menos un ADMIN" (DX-042, DB-012): si el cambio
   * degrada a un ADMIN, la comprobación y la escritura van en UNA transacción
   * que bloquea las membresías ADMIN vivas antes de contar. Dos degradaciones
   * concurrentes de los dos últimos ADMIN se serializan: la segunda ve un solo
   * ADMIN y devuelve `LAST_ADMIN` sin escribir nada.
   */
  updateById(userId: string, patch: StaffPatch): Promise<UpdateStaffOutcome>;

  /**
   * Soft-deletes (sets `deletedAt`) the active `ClinicMembership` for
   * `userId` in the current tenant. Tenant-scoped (via RLS /
   * `runWithTenant`). Misma garantía atómica que `updateById`: nunca deja la
   * clínica sin ADMIN activo (`LAST_ADMIN`).
   */
  deactivateById(userId: string): Promise<DeactivateStaffOutcome>;
}
