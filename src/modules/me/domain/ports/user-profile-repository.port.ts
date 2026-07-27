export const USER_PROFILE_REPOSITORY = Symbol('USER_PROFILE_REPOSITORY');

export interface UserRecord {
  id: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  emailVerifiedAt: Date | null;
}

export interface UserProfileRepository {
  findUserById(userId: string): Promise<UserRecord | null>;
  findClinicName(tenantId: string): Promise<string | null>;
  getPasswordHash(userId: string): Promise<string | null>;
  updateName(userId: string, fullName: string): Promise<void>;
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
  updateAvatarUrl(userId: string, avatarUrl: string | null): Promise<void>;
}
