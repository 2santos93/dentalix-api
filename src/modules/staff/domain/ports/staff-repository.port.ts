import { ClinicRole } from '@prisma/client';
import { StaffMember } from '../entities/staff-member.entity';

export const STAFF_REPOSITORY = Symbol('STAFF_REPOSITORY');

export interface StaffRepository {
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
   * current tenant. Returns `null` if there is no matching active
   * membership. Tenant-scoped (via RLS / `runWithTenant`).
   */
  updateById(
    userId: string,
    patch: { fullName?: string; role?: ClinicRole },
  ): Promise<StaffMember | null>;

  /**
   * Soft-deletes (sets `deletedAt`) the active `ClinicMembership` for
   * `userId` in the current tenant. Returns whether a row was affected.
   * Tenant-scoped (via RLS / `runWithTenant`).
   */
  deactivateById(userId: string): Promise<boolean>;

  /**
   * Count of active (non-deleted) `ADMIN` memberships for the current
   * tenant, joined to non-deleted users. Tenant-scoped (via RLS /
   * `runWithTenant`).
   */
  countActiveAdmins(): Promise<number>;
}
