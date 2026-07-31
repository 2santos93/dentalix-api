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
   * Looks up a `User` by email with NO tenant scoping — `users` has no RLS
   * (global table, same as `PrismaAuthRepository.findUserByEmail`). Used to
   * detect whether an invited email already belongs to an existing user
   * before deciding whether to create one or just add a membership.
   */
  findUserByEmailGlobal(email: string): Promise<{ id: string } | null>;

  /**
   * Creates a `User` and its `ClinicMembership` for the current tenant in a
   * single transaction. Tenant-scoped (via RLS / `runWithTenant`).
   */
  create(input: {
    fullName: string;
    email: string;
    role: ClinicRole;
    passwordHash: string;
  }): Promise<StaffMember>;

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
   * Reactivates a previously-removed staff member: if `userId` has a
   * SOFT-DELETED `ClinicMembership` in the current tenant, clears its
   * `deletedAt` and sets `role`, returning the refreshed StaffMember. Returns
   * `null` when there's nothing to reactivate (no membership here, or the only
   * one is already active). The user's existing credentials are preserved.
   * Tenant-scoped (via RLS / `runWithTenant`).
   */
  reactivateMembership(
    userId: string,
    role: ClinicRole,
  ): Promise<StaffMember | null>;

  /**
   * Count of active (non-deleted) `OWNER` memberships for the current
   * tenant, joined to non-deleted users. Tenant-scoped (via RLS /
   * `runWithTenant`).
   */
  countActiveOwners(): Promise<number>;
}
