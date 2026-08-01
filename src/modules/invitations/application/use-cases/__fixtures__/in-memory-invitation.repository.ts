import { ClinicRole } from '@prisma/client';
import { ClinicInvitation } from '../../../domain/entities/clinic-invitation.entity';
import {
  AcceptOutcome,
  InvitationRepository,
} from '../../../domain/ports/invitation-repository.port';
import { hashInvitationToken } from '../../invitation-token';

// `ClinicInvitation` (the API-facing entity) deliberately has no `tokenHash`
// field (see the port) — the fake still has to look rows up by hash like the
// real Prisma repo, so it tracks it on the stored row and strips it via
// `toEntity` (mirrors `mapToEntity` in prisma-invitation.repository.ts).
type StoredInvitation = ClinicInvitation & { tokenHash: string };

interface StoredUser {
  id: string;
  email: string;
  fullName: string;
  passwordHash: string;
}

interface StoredMembership {
  userId: string;
  tenantId: string;
  role: ClinicRole;
  deletedAt: Date | null;
}

let seq = 0;
const NOW = new Date('2026-01-01T00:00:00.000Z');
const TENANT_ID = 't1';

/**
 * Real in-memory fake for `InvitationRepository` (same convention as
 * `InMemoryPaymentRepository`): implements the actual filtering/reactivation
 * logic the Prisma repo has — pending = not accepted/not revoked, revoke is a
 * check-and-set, accept reuses an existing membership instead of duplicating
 * it — rather than a canned stub, so use-case specs genuinely exercise those
 * rules instead of trusting a mock's say-so.
 */
export class InMemoryInvitationRepository implements InvitationRepository {
  private readonly invitations: StoredInvitation[] = [];
  private readonly users: StoredUser[] = [];
  private readonly memberships: StoredMembership[] = [];
  /** Backs `findTenantName()`; tests can overwrite it directly. */
  tenantName: string | null = 'Clínica Demo';

  /** Test helper: seed an invitation row directly, bypassing use-case validation. */
  seedInvitation(
    overrides: Partial<StoredInvitation> & { token?: string } = {},
  ): ClinicInvitation {
    const { token, ...rest } = overrides;
    const row: StoredInvitation = {
      id: rest.id ?? `inv-${++seq}`,
      tenantId: rest.tenantId ?? TENANT_ID,
      email: rest.email ?? `invitee${seq}@clinic.com`,
      fullName: rest.fullName ?? 'Invitee',
      role: rest.role ?? ClinicRole.ASSISTANT,
      // Far in the future by default (decoupled from `NOW`, which is
      // deliberately a fixed past date used for `createdAt`/`revokedAt`) so a
      // seeded invitation reads as VALID unless a test says otherwise.
      expiresAt: rest.expiresAt ?? new Date('2099-01-01T00:00:00.000Z'),
      acceptedAt: rest.acceptedAt ?? null,
      revokedAt: rest.revokedAt ?? null,
      invitedById: rest.invitedById ?? null,
      createdAt: rest.createdAt ?? NOW,
      tokenHash: token
        ? hashInvitationToken(token)
        : (rest.tokenHash ?? `hash-${seq}`),
    };
    this.invitations.push(row);
    return this.toEntity(row);
  }

  /** Test helper: seed a global (`users` table) user. */
  seedUser(overrides: Partial<StoredUser> = {}): StoredUser {
    const user: StoredUser = {
      id: overrides.id ?? `user-${++seq}`,
      email: overrides.email ?? `user${seq}@clinic.com`,
      fullName: overrides.fullName ?? 'Existing User',
      passwordHash: overrides.passwordHash ?? 'HASH',
    };
    this.users.push(user);
    return user;
  }

  /** Test helper: seed an ACTIVE membership, creating the user if needed. */
  seedActiveMember(overrides: {
    email: string;
    userId?: string;
    role?: ClinicRole;
    tenantId?: string;
  }): StoredUser {
    const user =
      this.users.find((u) => u.email === overrides.email) ??
      this.seedUser({ id: overrides.userId, email: overrides.email });
    this.memberships.push({
      userId: user.id,
      tenantId: overrides.tenantId ?? TENANT_ID,
      role: overrides.role ?? ClinicRole.ASSISTANT,
      deletedAt: null,
    });
    return user;
  }

  // Explicit field-by-field mapping (mirrors `mapToEntity` in the Prisma
  // repo) so it stays obviously in sync with the entity shape, and never
  // leaks `tokenHash` to callers.
  private toEntity(row: StoredInvitation): ClinicInvitation {
    return {
      id: row.id,
      tenantId: row.tenantId,
      email: row.email,
      fullName: row.fullName,
      role: row.role,
      expiresAt: row.expiresAt,
      acceptedAt: row.acceptedAt,
      revokedAt: row.revokedAt,
      invitedById: row.invitedById,
      createdAt: row.createdAt,
    };
  }

  listPending(): Promise<ClinicInvitation[]> {
    const rows = this.invitations
      .filter((i) => i.acceptedAt === null && i.revokedAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((i) => this.toEntity(i));
    return Promise.resolve(rows);
  }

  findByTokenHash(tokenHash: string): Promise<ClinicInvitation | null> {
    const row = this.invitations.find((i) => i.tokenHash === tokenHash);
    return Promise.resolve(row ? this.toEntity(row) : null);
  }

  findActiveMembershipByEmail(
    email: string,
  ): Promise<{ userId: string } | null> {
    const user = this.users.find((u) => u.email === email);
    if (!user) return Promise.resolve(null);
    const membership = this.memberships.find(
      (m) => m.userId === user.id && m.deletedAt === null,
    );
    return Promise.resolve(membership ? { userId: user.id } : null);
  }

  findUserByEmailGlobal(
    email: string,
  ): Promise<{ id: string; passwordHash: string } | null> {
    const user = this.users.find((u) => u.email === email);
    return Promise.resolve(
      user ? { id: user.id, passwordHash: user.passwordHash } : null,
    );
  }

  revokePendingByEmail(email: string): Promise<number> {
    const pending = this.invitations.filter(
      (i) => i.email === email && i.acceptedAt === null && i.revokedAt === null,
    );
    pending.forEach((i) => {
      i.revokedAt = NOW;
    });
    return Promise.resolve(pending.length);
  }

  revokeById(id: string): Promise<boolean> {
    // Atomic check-and-set (mirrors PrismaInvitationRepository.revokeById's
    // `updateMany({where:{id, acceptedAt:null, revokedAt:null}, ...})`).
    const row = this.invitations.find(
      (i) => i.id === id && i.acceptedAt === null && i.revokedAt === null,
    );
    if (!row) return Promise.resolve(false);
    row.revokedAt = NOW;
    return Promise.resolve(true);
  }

  create(input: {
    email: string;
    fullName: string;
    role: ClinicRole;
    tokenHash: string;
    expiresAt: Date;
    invitedById?: string;
  }): Promise<ClinicInvitation> {
    const row: StoredInvitation = {
      id: `inv-${++seq}`,
      tenantId: TENANT_ID,
      email: input.email,
      fullName: input.fullName,
      role: input.role,
      expiresAt: input.expiresAt,
      acceptedAt: null,
      revokedAt: null,
      invitedById: input.invitedById ?? null,
      createdAt: NOW,
      tokenHash: input.tokenHash,
    };
    this.invitations.push(row);
    return Promise.resolve(this.toEntity(row));
  }

  acceptTransactional(input: {
    invitationId: string;
    email: string;
    role: ClinicRole;
    existingUserId?: string;
    newUser?: { fullName: string; passwordHash: string };
  }): Promise<AcceptOutcome> {
    let userId: string;
    if (input.newUser) {
      const user = this.seedUser({
        email: input.email,
        fullName: input.newUser.fullName,
        passwordHash: input.newUser.passwordHash,
      });
      userId = user.id;
    } else {
      if (!input.existingUserId) {
        throw new Error(
          'acceptTransactional requires newUser or existingUserId',
        );
      }
      userId = input.existingUserId;
    }

    // Reuse (reactivate) an existing membership instead of duplicating it —
    // same "already an active member" idempotency the Prisma repo provides.
    const membership = this.memberships.find(
      (m) => m.userId === userId && m.tenantId === TENANT_ID,
    );
    if (membership) {
      membership.deletedAt = null;
      membership.role = input.role;
    } else {
      this.memberships.push({
        userId,
        tenantId: TENANT_ID,
        role: input.role,
        deletedAt: null,
      });
    }

    const invitation = this.invitations.find(
      (i) => i.id === input.invitationId,
    );
    if (invitation) {
      invitation.acceptedAt = NOW;
    }

    return Promise.resolve({ userId, role: input.role });
  }

  findTenantName(): Promise<string | null> {
    return Promise.resolve(this.tenantName);
  }
}
