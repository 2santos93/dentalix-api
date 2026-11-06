import type { ClinicRole, Prisma } from '@prisma/client';
import type {
  PasswordResetRepository,
  ResetRecipient,
  ResetTokenRecord,
} from '../../../domain/ports/password-reset-repository.port';
import type {
  PasswordResetEmail,
  PasswordResetNotifier,
  PreparedPasswordResetEmail,
} from '../../../domain/ports/password-reset-notifier.port';
import { PasswordResetThrottledError } from '../../../domain/password-reset-throttled.error';

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
  tokens: (ResetTokenRecord & { tokenHash: string; createdAt: Date })[] = [];
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

  /** Clínicas de las transacciones que encolaron su email (DX-149-ter). */
  issuedWithEmail: string[] = [];
  /** Hace fallar la próxima `issue` antes de cambiar nada. */
  failNextIssue: Error | null = null;

  /**
   * Como la transacción de Prisma: si `enqueue` lanza, nada de lo hecho
   * queda (el token anterior sigue vivo).
   */
  async issue(input: {
    tenantId: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
    userDailyLimit: number;
    enqueue?: (tx: Prisma.TransactionClient) => Promise<void>;
  }): Promise<void> {
    if (this.failNextIssue) {
      const error = this.failNextIssue;
      this.failNextIssue = null;
      throw error;
    }
    // DX-149-quater: el tope por usuario (todas sus clínicas) en 24 h.
    const since = input.now.getTime() - 24 * 60 * 60 * 1000;
    const issuedToday = this.tokens.filter(
      (t) => t.userId === input.userId && t.createdAt.getTime() > since,
    ).length;
    if (issuedToday >= input.userDailyLimit) {
      throw new PasswordResetThrottledError('USER_QUOTA');
    }
    if (input.enqueue) {
      await input.enqueue({} as Prisma.TransactionClient);
      this.issuedWithEmail.push(input.tenantId);
    }
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
      createdAt: input.now,
    });
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
  /** DX-149-quater: el tope por usuario (el del destinatario, 5). */
  dailyLimit = 5;
  /** El recuento bajo candado (en la transacción) ya no deja enviar. */
  throttleInTx = false;
  kicks = 0;

  withinQuota(): Promise<boolean> {
    return Promise.resolve(this.quotaOk);
  }

  userDailyLimit(): number {
    return this.dailyLimit;
  }

  prepare(email: PasswordResetEmail): Promise<PreparedPasswordResetEmail> {
    return Promise.resolve({
      insert: () => {
        if (this.throttleInTx) {
          return Promise.reject(new PasswordResetThrottledError('QUOTA'));
        }
        this.sent.push(email);
        return Promise.resolve();
      },
      kick: () => {
        this.kicks += 1;
      },
    });
  }
}
