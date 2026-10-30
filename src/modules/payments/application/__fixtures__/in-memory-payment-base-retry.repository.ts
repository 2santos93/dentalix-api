import type { PaymentBaseRetryReason } from '../../domain/payment-base-retry';
import type {
  PaymentBaseBacklog,
  PaymentBaseRetryCandidate,
  PaymentBaseRetryFailure,
  PaymentBaseRetryRepository,
  PaymentRatePendingDay,
} from '../../domain/ports/payment-base-retry-repository.port';
import { pendingOnDayOf } from '../../domain/payment-rate-pending-day';

export interface FakePaymentBaseRetry {
  candidate: PaymentBaseRetryCandidate;
  nextAttemptAt: Date;
  lastReason: PaymentBaseRetryReason | null;
  createdAt: Date;
}

/**
 * Fake en memoria de `PaymentBaseRetryRepository` con su reloj (`now`): la
 * selección es la del real (vencidos, el que venció antes primero) y
 * `postpone` aplaza desde `now`.
 */
export class InMemoryPaymentBaseRetryRepository implements PaymentBaseRetryRepository {
  now = new Date('2026-10-30T12:00:00Z');
  readonly rows = new Map<string, FakePaymentBaseRetry>();
  /** Clínicas que `dueTenantIds` devuelve. */
  dueTenants: string[] = [];

  /** Un abono pendiente que venció en `nextAttemptAt` (por defecto, ya). */
  add(
    candidate: Partial<PaymentBaseRetryCandidate> & { paymentId: string },
    nextAttemptAt: Date = this.now,
  ): void {
    this.rows.set(candidate.paymentId, {
      candidate: {
        attempts: 0,
        live: true,
        amount: 100,
        currency: 'USD',
        paidOn: '2026-10-30',
        targetCurrency: 'USD',
        planCurrency: 'USD',
        hasBase: false,
        exchangeRateCurrency: candidate.targetCurrency ?? 'USD',
        frozenRate: null,
        ...candidate,
      },
      nextAttemptAt,
      lastReason: null,
      createdAt: nextAttemptAt,
    });
  }

  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }

  dueTenantIds(): Promise<string[]> {
    return Promise.resolve([...this.dueTenants]);
  }

  due(limit: number): Promise<PaymentBaseRetryCandidate[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.nextAttemptAt.getTime() <= this.now.getTime())
        .sort(
          (a, b) =>
            a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() ||
            a.candidate.paymentId.localeCompare(b.candidate.paymentId),
        )
        .slice(0, limit)
        .map((r) => ({ ...r.candidate })),
    );
  }

  resolve(paymentId: string): Promise<void> {
    // Map en memoria (no la BD): la regla de borrado duro no aplica.
    // eslint-disable-next-line no-restricted-syntax
    this.rows.delete(paymentId);
    return Promise.resolve();
  }

  postpone(paymentId: string, failure: PaymentBaseRetryFailure): Promise<void> {
    const row = this.rows.get(paymentId);
    if (row) {
      row.candidate.attempts = failure.attempts;
      row.lastReason = failure.reason;
      row.nextAttemptAt = new Date(this.now.getTime() + failure.delayMs);
    }
    return Promise.resolve();
  }

  wake(): Promise<number> {
    let woken = 0;
    for (const row of this.rows.values()) {
      if (row.nextAttemptAt.getTime() > this.now.getTime()) {
        row.nextAttemptAt = this.now;
        woken += 1;
      }
    }
    return Promise.resolve(woken);
  }

  backlog(olderThanHours: number): Promise<PaymentBaseBacklog> {
    const limit = this.now.getTime() - olderThanHours * 3_600_000;
    const old = [...this.rows.values()].filter(
      (r) => r.candidate.live && r.createdAt.getTime() <= limit,
    );
    const oldest = old.map((r) => r.createdAt.getTime()).sort((a, b) => a - b);
    return Promise.resolve({
      count: old.length,
      oldestSince: oldest.length > 0 ? new Date(oldest[0]) : null,
    });
  }

  /** Días con tasa del proveedor guardada (DX-402). */
  readonly providerDays = new Set<string>();
  /** Monedas con tasa manual registrada, por día (DX-402). */
  readonly manualRates = new Map<string, Set<string>>();

  pendingOnDay(date: string, currency: string): Promise<PaymentRatePendingDay> {
    const pairs = [...this.rows.values()]
      .map(({ candidate: c }) => c)
      .filter((c) => c.live && !c.frozenRate && c.paidOn === date);
    return Promise.resolve(
      pendingOnDayOf(
        pairs,
        currency,
        this.manualRates.get(date) ?? new Set(),
        this.providerDays.has(date),
      ),
    );
  }
}
