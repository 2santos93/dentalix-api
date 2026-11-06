import type { Prisma } from '@prisma/client';
import { EmailTemplateName } from '../../domain/email-message';
import {
  ClaimedOutboxEmail,
  EmailDeliveryStatus,
  EmailOutboxRepository,
  NewOutboxEmail,
  NewPlatformOutboxEmail,
  OutboxQuotaGuard,
  OutboxSettlement,
  PlatformRecipientQuota,
  QuotaLockScope,
  RecentSends,
} from '../../domain/ports/email-outbox-repository.port';

export interface StoredOutboxEmail extends NewPlatformOutboxEmail {
  /** `null` = email de plataforma. */
  tenantId: string | null;
  id: string;
  payload: Buffer;
  storedPayload: Buffer | null;
  status: EmailDeliveryStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

let seq = 0;

/**
 * Fake en memoria con la MISMA semántica que las funciones SQL: reclamar pasa
 * a SENDING y suma el intento, cerrar solo actúa sobre SENDING y borra el
 * mensaje al terminar.
 */
export class InMemoryEmailOutboxRepository implements EmailOutboxRepository {
  readonly rows: StoredOutboxEmail[] = [];
  /** Los `scope` de candado que pidió cada insert con tope (DX-149-ter). */
  readonly guardScopes: QuotaLockScope[] = [];
  brands = new Map<
    string,
    { name: string; logoUrl: string | null; primaryColor: string | null }
  >();

  /** Con `guard`, cuenta y decide antes de guardar (como bajo el candado). */
  async insert(
    row: NewOutboxEmail,
    guard?: OutboxQuotaGuard,
    scope?: QuotaLockScope,
  ): Promise<{ id: string }> {
    if (guard) this.guardScopes.push(scope ?? 'recipient-and-tenant');
    if (guard) guard(await this.recentSends(row.tenantId, row.toHash));
    return this.store(row);
  }

  insertInTx(
    _tx: Prisma.TransactionClient,
    row: NewOutboxEmail,
    guard?: OutboxQuotaGuard,
    scope?: QuotaLockScope,
  ): Promise<{ id: string }> {
    return this.insert(row, guard, scope);
  }

  /** Misma regla que email_outbox_enqueue_platform_security (DX-021-bis). */
  insertPlatformSecurity(
    row: NewPlatformOutboxEmail,
    minIntervalSeconds: number,
  ): Promise<{ id: string } | null> {
    const recent = this.rows.some(
      (r) =>
        r.tenantId === null &&
        r.toHash === row.toHash &&
        r.template === row.template &&
        r.referenceId === row.referenceId &&
        Date.now() - r.createdAt.getTime() < minIntervalSeconds * 1000,
    );
    return Promise.resolve(
      recent ? null : this.store({ ...row, tenantId: null }),
    );
  }

  /** Misma regla que email_outbox_platform_allowed (DX-144). */
  platformRecipientAllowed(
    toHash: string,
    quota: PlatformRecipientQuota,
  ): Promise<boolean> {
    const now = Date.now();
    const mine = this.rows.filter(
      (r) =>
        r.tenantId === null &&
        r.toHash === toHash &&
        !['mfa-notice', 'mfa-enrollment-code'].includes(r.template),
    );
    const inCooldown = mine.some(
      (r) =>
        now - r.createdAt.getTime() < quota.recipientCooldownSeconds * 1000,
    );
    const today = mine.filter(
      (r) => now - r.createdAt.getTime() < 24 * 60 * 60 * 1000,
    ).length;
    return Promise.resolve(!inCooldown && today < quota.recipientDaily);
  }

  async insertPlatform(
    row: NewPlatformOutboxEmail,
    quota: PlatformRecipientQuota,
  ): Promise<{ id: string } | null> {
    if (!(await this.platformRecipientAllowed(row.toHash, quota))) return null;
    return this.store({ ...row, tenantId: null });
  }

  private store(row: NewPlatformOutboxEmail & { tenantId: string | null }): {
    id: string;
  } {
    const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
    this.rows.push({
      ...row,
      id,
      storedPayload: row.payload,
      createdAt: new Date(),
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(),
      lastError: null,
      sentAt: null,
    });
    return { id };
  }

  claimDue(limit: number, leaseSeconds: number): Promise<ClaimedOutboxEmail[]> {
    const now = Date.now();
    const due = this.rows
      .filter(
        (r) =>
          (r.status === 'PENDING' || r.status === 'SENDING') &&
          r.nextAttemptAt.getTime() <= now,
      )
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit);
    return Promise.resolve(
      due.map((r) => {
        r.status = 'SENDING';
        r.attempts += 1;
        r.nextAttemptAt = new Date(now + leaseSeconds * 1000);
        return {
          id: r.id,
          tenantId: r.tenantId,
          payload: r.storedPayload,
          attempts: r.attempts,
        };
      }),
    );
  }

  settle(
    id: string,
    attempts: number,
    outcome: OutboxSettlement,
  ): Promise<boolean> {
    const row = this.rows.find(
      (r) => r.id === id && r.status === 'SENDING' && r.attempts === attempts,
    );
    if (!row) return Promise.resolve(false);
    row.status = outcome.status;
    row.lastError = outcome.status === 'SENT' ? null : outcome.lastError;
    if (outcome.status === 'PENDING') {
      row.nextAttemptAt = new Date(Date.now() + outcome.retryDelayMs);
    }
    if (outcome.status === 'SENT') row.sentAt = new Date();
    if (outcome.status !== 'PENDING') row.storedPayload = null;
    return Promise.resolve(true);
  }

  /** DX-476: todos los pacientes de los enlaces se dan por archivados. */
  patientsArchived = false;

  patientArchivedFor(): Promise<boolean> {
    return Promise.resolve(this.patientsArchived);
  }

  supersedePending(
    tenantId: string,
    referenceId: string,
    template: EmailTemplateName,
  ): Promise<number> {
    const pending = this.rows.filter(
      (r) =>
        r.tenantId === tenantId &&
        r.referenceId === referenceId &&
        r.template === template &&
        r.status === 'PENDING',
    );
    for (const r of pending) {
      r.status = 'FAILED';
      r.storedPayload = null;
      r.lastError = 'Superseded';
    }
    return Promise.resolve(pending.length);
  }

  /** El fake no tiene RLS: los `referenceId` son únicos entre clínicas. */
  supersedePendingInTx(
    _tx: Prisma.TransactionClient,
    referenceId: string,
    template: EmailTemplateName,
  ): Promise<number> {
    const tenants = new Set(
      this.rows
        .filter((r) => r.referenceId === referenceId && r.tenantId !== null)
        .map((r) => r.tenantId as string),
    );
    return Promise.all(
      [...tenants].map((t) => this.supersedePending(t, referenceId, template)),
    ).then((counts) => counts.reduce((a, b) => a + b, 0));
  }

  access = { executable: true, ownerSeesAllRows: true };

  recentSends(tenantId: string, toHash: string): Promise<RecentSends> {
    const now = Date.now();
    const since = new Date(now - 24 * 60 * 60 * 1000);
    const ofTenant = this.rows.filter((r) => r.tenantId === tenantId);
    const toRecipient = ofTenant.filter((r) => r.toHash === toHash);
    const last = toRecipient.reduce<Date | null>(
      (acc, r) => (acc && acc > r.createdAt ? acc : r.createdAt),
      null,
    );
    return Promise.resolve({
      tenant: ofTenant.filter((r) => r.createdAt >= since).length,
      recipient: toRecipient.filter((r) => r.createdAt >= since).length,
      secondsSinceLastToRecipient: last ? (now - last.getTime()) / 1000 : null,
    });
  }

  dispatcherAccess(): Promise<{
    executable: boolean;
    ownerSeesAllRows: boolean;
  }> {
    return Promise.resolve(this.access);
  }

  findBrand(tenantId: string): Promise<{
    name: string;
    logoUrl: string | null;
    primaryColor: string | null;
  } | null> {
    return Promise.resolve(this.brands.get(tenantId) ?? null);
  }
}
