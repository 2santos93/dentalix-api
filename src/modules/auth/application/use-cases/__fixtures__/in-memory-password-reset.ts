import { ClinicRole } from '@prisma/client';
import type {
  PasswordResetRepository,
  ResetRecipient,
  ResetTokenRecord,
} from '../../../domain/ports/password-reset-repository.port';
import type {
  PasswordResetEmail,
  PasswordResetNotifier,
} from '../../../domain/ports/password-reset-notifier.port';

interface Member {
  tenantId: string;
  userId: string;
  email: string;
  fullName: string;
  role: ClinicRole;
  active: boolean;
}

/** Repositorio en memoria con la semántica del de Prisma. */
export class InMemoryPasswordResetRepository implements PasswordResetRepository {
  members: Member[] = [];
  tokens: (ResetTokenRecord & { tokenHash: string })[] = [];
  passwords = new Map<string, string>();
  tokenVersions = new Map<string, number>();

  addMember(member: Partial<Member> & { userId: string; tenantId: string }) {
    this.members.push({
      email: `${member.userId}@clinica.co`,
      fullName: 'Ana Pérez',
      role: 'DENTIST',
      active: true,
      ...member,
    });
    this.tokenVersions.set(member.userId, 0);
  }

  findActiveMember(
    tenantId: string,
    email: string,
  ): Promise<ResetRecipient | null> {
    const m = this.members.find(
      (x) =>
        x.tenantId === tenantId &&
        x.active &&
        x.email.toLowerCase() === email.toLowerCase(),
    );
    return Promise.resolve(
      m ? { userId: m.userId, email: m.email, fullName: m.fullName } : null,
    );
  }

  activeMembershipRole(
    tenantId: string,
    userId: string,
  ): Promise<ClinicRole | null> {
    const m = this.members.find(
      (x) => x.tenantId === tenantId && x.userId === userId && x.active,
    );
    return Promise.resolve(m?.role ?? null);
  }

  issue(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<void> {
    for (const t of this.tokens) {
      if (t.userId === input.userId && !t.invalidatedAt) {
        t.invalidatedAt = input.now;
      }
    }
    this.tokens.push({
      id: `token-${this.tokens.length + 1}`,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      usedAt: null,
      invalidatedAt: null,
    });
    return Promise.resolve();
  }

  findByHash(tokenHash: string): Promise<ResetTokenRecord | null> {
    const t = this.tokens.find((x) => x.tokenHash === tokenHash);
    return Promise.resolve(t ? { ...t } : null);
  }

  consumeAndSetPassword(input: {
    tokenId: string;
    userId: string;
    passwordHash: string;
    now: Date;
  }): Promise<boolean> {
    const t = this.tokens.find((x) => x.id === input.tokenId);
    if (!t || t.usedAt || t.invalidatedAt || t.expiresAt <= input.now) {
      return Promise.resolve(false);
    }
    t.usedAt = input.now;
    t.invalidatedAt = input.now;
    this.passwords.set(input.userId, input.passwordHash);
    this.tokenVersions.set(
      input.userId,
      (this.tokenVersions.get(input.userId) ?? 0) + 1,
    );
    return Promise.resolve(true);
  }
}

export class FakePasswordResetNotifier implements PasswordResetNotifier {
  sent: PasswordResetEmail[] = [];
  quotaOk = true;

  withinQuota(): Promise<boolean> {
    return Promise.resolve(this.quotaOk);
  }

  send(email: PasswordResetEmail): Promise<void> {
    this.sent.push(email);
    return Promise.resolve();
  }
}
