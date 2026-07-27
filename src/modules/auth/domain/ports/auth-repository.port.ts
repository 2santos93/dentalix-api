import { ClinicRole } from '@prisma/client';

export interface CreateClinicWithOwnerInput {
  clinicName: string;
  subdomain: string;
  email: string;
  passwordHash: string;
  fullName: string;
}

export interface MembershipRecord {
  userId: string;
  passwordHash: string;
  role: ClinicRole;
}

export const AUTH_REPOSITORY = Symbol('AUTH_REPOSITORY');

export interface AuthRepository {
  findUserByEmail(email: string): Promise<{ id: string } | null>;
  findTenantBySubdomain(subdomain: string): Promise<{ id: string } | null>;
  createClinicWithOwner(
    input: CreateClinicWithOwnerInput,
  ): Promise<{ tenantId: string; userId: string }>;
  findMembership(
    tenantId: string,
    email: string,
  ): Promise<MembershipRecord | null>;
  revokeToken(jti: string, expiresAt: Date): Promise<void>;
  isTokenRevoked(jti: string): Promise<boolean>;
}
