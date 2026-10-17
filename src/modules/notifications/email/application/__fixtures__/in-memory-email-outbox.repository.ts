import { EmailTemplateName } from '../../domain/email-message';
import {
  ClaimedOutboxEmail,
  EmailDeliveryStatus,
  EmailOutboxRepository,
  NewOutboxEmail,
  NewPlatformOutboxEmail,
  OutboxSettlement,
  PlatformRecipientQuota,
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
  brands = new Map<
    string,
    { name: string; logoUrl: string | null; primaryColor: string | null }
  >();

  insert(row: NewOutboxEmail): Promise<{ id: string }> {
    return Promise.resolve(this.store(row));
  }

  /** Misma regla que email_outbox_platform_allowed (DX-144). */
  platformRecipientAllowed(
    toHash: string,
    quota: PlatformRecipientQuota,
  ): Promise<boolean> {
    const now = Date.now();
    const mine = this.rows.filter(
      (r) => r.tenantId === null && r.toHash === toHash,
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
    if (outcome.status === 'PENDING') row.nextAttemptAt = outcome.nextAttemptAt;
    if (outcome.status === 'SENT') row.sentAt = new Date();
    if (outcome.status !== 'PENDING') row.storedPayload = null;
    return Promise.resolve(true);
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

  access = { executable: true, ownerSeesAllRows: true };

  recentSends(
    tenantId: string,
    toHash: string,
    since: Date,
  ): Promise<{
    tenant: number;
    recipient: number;
    lastToRecipient: Date | null;
  }> {
    const ofTenant = this.rows.filter((r) => r.tenantId === tenantId);
    const toRecipient = ofTenant.filter((r) => r.toHash === toHash);
    const last = toRecipient.reduce<Date | null>(
      (acc, r) => (acc && acc > r.createdAt ? acc : r.createdAt),
      null,
    );
    return Promise.resolve({
      tenant: ofTenant.filter((r) => r.createdAt >= since).length,
      recipient: toRecipient.filter((r) => r.createdAt >= since).length,
      lastToRecipient: last,
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
