import { StaffMember } from '../entities/staff-member.entity';

export const STAFF_REPOSITORY = Symbol('STAFF_REPOSITORY');

export interface StaffRepository {
  /**
   * Active clinic staff — non-deleted `ClinicMembership` rows joined to their
   * `User`, tenant-scoped (via RLS / `runWithTenant`), ordered by full name.
   */
  listActive(): Promise<StaffMember[]>;
}
