import { ClinicRole, ExtraPermission } from '@prisma/client';

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
  /**
   * DX-090: lo que puede hacer en la clínica de la sesión, en términos del
   * catálogo de permisos: los de serie de su rol más los extra concedidos.
   */
  effectivePermissions: ExtraPermission[];
}
