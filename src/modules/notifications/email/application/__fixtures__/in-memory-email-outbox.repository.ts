import { EmailTemplateName } from '../../domain/email-message';
import {
  ClaimedOutboxEmail,
  EmailDeliveryStatus,
  EmailOutboxRepository,
  NewOutboxEmail,
  OutboxSettlement,
} from '../../domain/ports/email-outbox-repository.port';

export interface StoredOutboxEmail extends NewOutboxEmail {
  id: string;
  payload: Buffer;
  storedPayload: Buffer | null;
  status: EmailDeliveryStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  sentAt: Date | null;
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
    const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
    this.rows.push({
      ...row,
      id,
      storedPayload: row.payload,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(),
      lastError: null,
      sentAt: null,
    });
    return Promise.resolve({ id });
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

  settle(id: string, outcome: OutboxSettlement): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id && r.status === 'SENDING');
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

  findBrand(tenantId: string): Promise<{
    name: string;
    logoUrl: string | null;
    primaryColor: string | null;
  } | null> {
    return Promise.resolve(this.brands.get(tenantId) ?? null);
  }
}
