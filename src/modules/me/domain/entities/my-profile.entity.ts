import { ClinicRole } from '@prisma/client';

export interface MyProfileMembership {
  tenantId: string;
  clinicName: string;
  role: ClinicRole;
}

export interface MyProfile {
  id: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  emailVerifiedAt: Date | null;
  memberships: MyProfileMembership[];
}
