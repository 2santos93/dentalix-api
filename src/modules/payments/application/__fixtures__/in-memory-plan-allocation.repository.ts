import type {
  AllocatableItem,
  AllocationIncrement,
} from '../../domain/allocation-rules';
import type {
  AllocationTarget,
  PaymentAllocationsSnapshot,
  PaymentWithoutBase,
  PlanBalanceSnapshot,
  PlanAllocationRepository,
  PlanAllocationSnapshot,
  RebalanceOptions,
} from '../../domain/ports/plan-allocation-repository.port';

export interface FakeAllocationPayment {
  id: string;
  planId: string;
  paidAt: Date;
  createdAt: Date;
  /** `null`: sin base (sin tasa). */
  baseCents: number | null;
  manual?: boolean;
  voided?: boolean;
}

export interface FakeAllocationItem extends Omit<
  AllocatableItem,
  'allocatedCents'
> {
  planId: string;
}

export interface FakeAllocationRow {
  paymentId: string;
  itemId: string;
  cents: number;
  source: 'AUTO' | 'MANUAL';
  createdById: string | null;
}

/**
 * Fake en memoria de `PlanAllocationRepository` con la semántica del real:
 * donantes = abonos vivos NO fijados con base; ítems = facturables; escribe
 * AUTO los incrementos (sumando a la fila del par si existe); `dryRun` no
 * escribe; borra las solicitudes del plan.
 */
export class InMemoryPlanAllocationRepository implements PlanAllocationRepository {
  readonly payments: FakeAllocationPayment[] = [];
  readonly items: FakeAllocationItem[] = [];
  readonly allocations: FakeAllocationRow[] = [];
  /** Planes encolados, uno por solicitud (cola de solo-inserción). */
  readonly requests: string[] = [];
  readonly retiredPlans = new Set<string>();
  readonly failingPlans = new Set<string>();
  readonly bases = new Map<
    string,
    { amount: number; currency: string; rateDate: string }
  >();
  withoutBase: PaymentWithoutBase[] = [];
  tenants: string[] = [];

  allocatedCents(filter: { paymentId?: string; itemId?: string }): number {
    return this.allocations
      .filter(
        (a) =>
          (filter.paymentId === undefined ||
            a.paymentId === filter.paymentId) &&
          (filter.itemId === undefined || a.itemId === filter.itemId),
      )
      .reduce((sum, a) => sum + a.cents, 0);
  }

  rebalance(
    planId: string,
    options: RebalanceOptions,
    decide: (snapshot: PlanAllocationSnapshot) => AllocationIncrement[],
  ): Promise<number> {
    if (this.failingPlans.has(planId)) {
      return Promise.reject(new Error('reparto roto'));
    }
    const pending = this.requests.filter((id) => id === planId).length;
    if (options.onlyIfRequested && pending === 0) return Promise.resolve(0);
    if (this.retiredPlans.has(planId)) {
      this.dropRequests(planId);
      return Promise.resolve(0);
    }
    const snapshot: PlanAllocationSnapshot = {
      donors: this.payments
        .filter(
          (p) =>
            p.planId === planId &&
            p.baseCents !== null &&
            !p.manual &&
            !p.voided,
        )
        .map((p) => ({
          paymentId: p.id,
          paidAt: p.paidAt,
          createdAt: p.createdAt,
          baseCents: p.baseCents ?? 0,
          allocatedCents: this.allocatedCents({ paymentId: p.id }),
        })),
      items: this.items
        .filter((i) => i.planId === planId && i.billableCents > 0)
        .map(({ planId: _planId, ...item }) => ({
          ...item,
          allocatedCents: this.allocatedCents({ itemId: item.id }),
        })),
    };
    const increments = decide(snapshot);
    const total = increments.reduce((sum, inc) => sum + inc.cents, 0);
    if (options.dryRun) return Promise.resolve(total);
    for (const inc of increments) {
      const row = this.allocations.find(
        (a) => a.paymentId === inc.paymentId && a.itemId === inc.itemId,
      );
      if (row) row.cents += inc.cents;
      else {
        this.allocations.push({
          paymentId: inc.paymentId,
          itemId: inc.itemId,
          cents: inc.cents,
          source: 'AUTO',
          createdById: options.actorId,
        });
      }
    }
    this.dropRequests(planId);
    return Promise.resolve(total);
  }

  pendingPlanIds(preferPlanId?: string, limit?: number): Promise<string[]> {
    const ordered = [...new Set(this.requests)];
    if (preferPlanId && ordered.includes(preferPlanId)) {
      ordered.splice(ordered.indexOf(preferPlanId), 1);
      ordered.unshift(preferPlanId);
    }
    return Promise.resolve(
      limit === undefined ? ordered : ordered.slice(0, limit),
    );
  }

  planOfPayment(paymentId: string): Promise<string | null> {
    return Promise.resolve(
      this.payments.find((p) => p.id === paymentId)?.planId ?? null,
    );
  }

  paymentsWithoutBase(limit: number): Promise<PaymentWithoutBase[]> {
    return Promise.resolve(
      this.withoutBase
        .filter((p) => !this.bases.has(p.paymentId))
        .slice(0, limit),
    );
  }

  planIdsWithBases(): Promise<string[]> {
    const planIds = this.payments
      .filter((p) => p.baseCents !== null || this.bases.has(p.id))
      .map((p) => p.planId)
      .filter((planId) => !this.retiredPlans.has(planId));
    return Promise.resolve([...new Set(planIds)].sort());
  }

  ensureBase(
    paymentId: string,
    amount: number,
    currency: string,
    rateDate: string,
  ): Promise<boolean> {
    if (this.bases.has(paymentId)) return Promise.resolve(false);
    this.bases.set(paymentId, { amount, currency, rateDate });
    return Promise.resolve(true);
  }

  enqueuePlan(_tx: unknown, _tenantId: string, planId: string): Promise<void> {
    this.requests.push(planId);
    return Promise.resolve();
  }

  readPlanBalanceSnapshot(): Promise<PlanBalanceSnapshot | null> {
    return Promise.resolve(null);
  }

  // La reasignación (R10) se prueba con dobles propios y contra Postgres.
  findAllocationTarget(): Promise<AllocationTarget | null> {
    return Promise.resolve(null);
  }

  readPaymentAllocations(): Promise<PaymentAllocationsSnapshot | null> {
    return Promise.resolve(null);
  }

  replaceAllocations(): Promise<{
    previous: { itemId: string; cents: number }[];
  }> {
    return Promise.reject(new Error('no implementado en el fake'));
  }

  tenantIds(): Promise<string[]> {
    return Promise.resolve([...this.tenants]);
  }

  private dropRequests(planId: string): void {
    for (let i = this.requests.length - 1; i >= 0; i -= 1) {
      if (this.requests[i] === planId) this.requests.splice(i, 1);
    }
  }
}
