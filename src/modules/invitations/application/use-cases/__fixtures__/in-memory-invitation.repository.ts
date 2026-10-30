import { ClinicRole } from '@prisma/client';
import { ClinicInvitation } from '../../../domain/entities/clinic-invitation.entity';
import {
  AcceptUserResolution,
  AccountClaimBlockedError,
  AccountClaimConflictError,
  GlobalUserRecord,
  InvitationRepository,
} from '../../../domain/ports/invitation-repository.port';
import { hashInvitationToken } from '../../invitation-token';
import type { AuditEventDraft } from '../../../../audit/domain/audit-event';
import type {
  AuditRequestContext,
  AuditRequestMeta,
} from '../../../../audit/domain/audit-request-context';
import {
  invitationAcceptedAuditEvent,
  invitationCreatedAuditEvent,
  invitationResentAuditEvent,
  invitationRevokedAuditEvent,
} from '../../../domain/invitation-audit';

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
  tokenVersion: number;
  /** Por defecto verificado; `null` = cuenta reclamable (DX-029). */
  emailVerifiedAt: Date | null;
  isPlatformAdmin: boolean;
}

interface StoredMembership {
  userId: string;
  tenantId: string;
  role: ClinicRole;
  deletedAt: Date | null;
  /**
   * DX-089: sedes activas de `membership_locations` (ya filtradas, como las
   * devuelve el repo de Prisma). `null` = sin filas = todas las sedes. Las
   * filas sobreviven al borrado lógico de la membresía.
   */
  allowedLocationIds?: string[] | null;
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
  /**
   * DX-359: eventos que el repo de Prisma escribe en la transacción de cada
   * escritura, con los mismos constructores.
   */
  readonly auditEvents: AuditEventDraft[] = [];
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
      tokenVersion: overrides.tokenVersion ?? 0,
      emailVerifiedAt:
        overrides.emailVerifiedAt === undefined
          ? NOW
          : overrides.emailVerifiedAt,
      isPlatformAdmin: overrides.isPlatformAdmin ?? false,
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

  /** Test helper: una membresía de un usuario ya sembrado, en cualquier clínica. */
  seedMembership(input: {
    userId: string;
    tenantId: string;
    role?: ClinicRole;
    deletedAt?: Date | null;
    allowedLocationIds?: string[] | null;
  }): void {
    this.memberships.push({
      userId: input.userId,
      tenantId: input.tenantId,
      role: input.role ?? ClinicRole.ASSISTANT,
      deletedAt: input.deletedAt ?? null,
      allowedLocationIds: input.allowedLocationIds ?? null,
    });
  }

  /** Test helper: las membresías de un usuario, de todas las clínicas. */
  membershipsOf(userId: string): StoredMembership[] {
    return this.memberships.filter((m) => m.userId === userId);
  }

  /** Test helper: ¿se aceptó la invitación de ese token? */
  isAccepted(token: string): boolean {
    const row = this.invitations.find(
      (i) => i.tokenHash === hashInvitationToken(token),
    );
    return row?.acceptedAt != null;
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

  findUserByEmailGlobal(email: string): Promise<GlobalUserRecord | null> {
    const user = this.users.find((u) => u.email === email);
    return Promise.resolve(
      user
        ? {
            id: user.id,
            passwordHash: user.passwordHash,
            tokenVersion: user.tokenVersion,
            emailVerifiedAt: user.emailVerifiedAt,
            isPlatformAdmin: user.isPlatformAdmin,
          }
        : null,
    );
  }

  hasOtherActiveMemberships(userId: string): Promise<boolean> {
    return Promise.resolve(this.otherActive(userId));
  }

  private otherActive(userId: string): boolean {
    return this.memberships.some(
      (m) =>
        m.userId === userId && m.deletedAt === null && m.tenantId !== TENANT_ID,
    );
  }

  revokePendingByEmail(
    email: string,
    audit: AuditRequestContext,
  ): Promise<string[]> {
    const pending = this.invitations.filter(
      (i) => i.email === email && i.acceptedAt === null && i.revokedAt === null,
    );
    pending.forEach((i) => {
      i.revokedAt = NOW;
      this.auditEvents.push(
        invitationRevokedAuditEvent(audit, i.id, 'REPLACED'),
      );
    });
    return Promise.resolve(pending.map((i) => i.id));
  }

  findPendingById(id: string): Promise<ClinicInvitation | null> {
    const row = this.invitations.find(
      (i) => i.id === id && i.acceptedAt === null && i.revokedAt === null,
    );
    return Promise.resolve(row ? this.toEntity(row) : null);
  }

  reissue(
    id: string,
    input: { tokenHash: string; expiresAt: Date },
    audit: AuditRequestContext,
  ): Promise<ClinicInvitation | null> {
    const row = this.invitations.find(
      (i) => i.id === id && i.acceptedAt === null && i.revokedAt === null,
    );
    if (!row) return Promise.resolve(null);
    row.tokenHash = input.tokenHash;
    row.expiresAt = input.expiresAt;
    this.auditEvents.push(invitationResentAuditEvent(audit, id));
    return Promise.resolve(this.toEntity(row));
  }

  revokeById(id: string, audit: AuditRequestContext): Promise<boolean> {
    // Atomic check-and-set (mirrors PrismaInvitationRepository.revokeById's
    // `updateMany({where:{id, acceptedAt:null, revokedAt:null}, ...})`).
    const row = this.invitations.find(
      (i) => i.id === id && i.acceptedAt === null && i.revokedAt === null,
    );
    if (!row) return Promise.resolve(false);
    row.revokedAt = NOW;
    this.auditEvents.push(invitationRevokedAuditEvent(audit, id, 'REVOKED'));
    return Promise.resolve(true);
  }

  create(
    input: {
      email: string;
      fullName: string;
      role: ClinicRole;
      tokenHash: string;
      expiresAt: Date;
      invitedById?: string;
    },
    audit: AuditRequestContext,
  ): Promise<ClinicInvitation> {
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
      createdAt: new Date(),
      tokenHash: input.tokenHash,
    };
    this.invitations.push(row);
    this.auditEvents.push(
      invitationCreatedAuditEvent(audit, row.id, input.role),
    );
    return Promise.resolve(this.toEntity(row));
  }

  /** Test helper: el usuario tal como quedó guardado. */
  userById(id: string): StoredUser | undefined {
    return this.users.find((u) => u.id === id);
  }

  countCreatedSince(since: Date): Promise<number> {
    return Promise.resolve(
      this.invitations.filter((i) => i.createdAt >= since).length,
    );
  }

  acceptTransactional(input: {
    invitationId: string;
    email: string;
    role: ClinicRole;
    user: AcceptUserResolution;
    request: AuditRequestMeta | null;
  }): ReturnType<InvitationRepository['acceptTransactional']> {
    let user: StoredUser;
    const resolution = input.user;
    if ('newUser' in resolution) {
      user = this.seedUser({
        email: input.email,
        fullName: resolution.newUser.fullName,
        passwordHash: resolution.newUser.passwordHash,
        emailVerifiedAt: NOW,
      });
    } else if ('claim' in resolution) {
      const found = this.userById(resolution.claim.userId);
      if (!found || found.emailVerifiedAt !== null) {
        return Promise.reject(new AccountClaimConflictError());
      }
      if (found.isPlatformAdmin || this.otherActive(found.id)) {
        return Promise.reject(new AccountClaimBlockedError());
      }
      found.passwordHash = resolution.claim.passwordHash;
      found.emailVerifiedAt = NOW;
      found.tokenVersion += 1;
      user = found;
    } else {
      const found = this.userById(resolution.existingUserId);
      if (!found) throw new Error('unknown user');
      found.emailVerifiedAt ??= NOW;
      user = found;
    }
    const userId = user.id;

    // Reuse (reactivate) an existing membership instead of duplicating it —
    // same "already an active member" idempotency the Prisma repo provides.
    const membership = this.memberships.find(
      (m) => m.userId === userId && m.tenantId === TENANT_ID,
    );
    const reactivated = membership?.deletedAt != null;
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

    const allowedLocationIds =
      input.role === ClinicRole.ADMIN
        ? null
        : (membership?.allowedLocationIds ?? null);
    this.auditEvents.push(
      invitationAcceptedAuditEvent(input.request, {
        tenantId: TENANT_ID,
        invitationId: input.invitationId,
        userId,
        role: input.role,
        locationIds: allowedLocationIds,
        reactivated,
      }),
    );
    return Promise.resolve({
      userId,
      role: input.role,
      tokenVersion: user.tokenVersion,
      allowedLocationIds: membership?.allowedLocationIds ?? null,
    });
  }

  findTenantName(): Promise<string | null> {
    return Promise.resolve(this.tenantName);
  }
}
