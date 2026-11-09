import { NotFoundException } from '@nestjs/common';
import { itemRates } from '../../../../discounts/domain/reference-in-plan';
import type { TreatmentPlanWithItems } from '../../../domain/entities/treatment-plan.entity';
import type { PlanFacts } from '../../../domain/ports/treatment-plan-repository.port';
import type {
  ApplyRepricingOutcome,
  DecideRepricing,
  PlanRepricingRepository,
  RepricingIdempotency,
  RepricingRecord,
  RepricingSubject,
} from '../../../domain/ports/plan-repricing-repository.port';

export const REPRICING_WRITE_LOCATION_ID = 'loc-write';

/**
 * `PlanRepricingRepository` de los unit: un plan en memoria por id. `apply`
 * hace lo mismo que el de Prisma (clave primero, luego el plan «bloqueado» y
 * releído, `decide`, ítems, validez y fila); `beforeLock` deja cambiar el plan
 * entre la lectura previa y la transacción.
 */
export class InMemoryPlanRepricingRepository implements PlanRepricingRepository {
  readonly plans = new Map<string, TreatmentPlanWithItems>();
  facts: PlanFacts = {
    hasLivePayments: false,
    hasActivePaymentPlan: false,
    hasCreditEntries: false,
  };
  readonly records: (RepricingRecord & RepricingIdempotency)[] = [];
  beforeLock?: (plan: TreatmentPlanWithItems) => void;
  private seq = 0;

  seed(plan: TreatmentPlanWithItems): void {
    this.plans.set(plan.id, structuredClone(plan));
  }

  plan(id: string): TreatmentPlanWithItems {
    const plan = this.plans.get(id);
    if (!plan) throw new Error(`sin plan ${id}`);
    return plan;
  }

  load(patientId: string, planId: string): Promise<RepricingSubject | null> {
    const plan = this.plans.get(planId);
    if (!plan || plan.patientId !== patientId) return Promise.resolve(null);
    return Promise.resolve({
      plan: structuredClone(plan),
      facts: { ...this.facts },
    });
  }

  apply(
    patientId: string,
    planId: string,
    idempotency: RepricingIdempotency,
    actorUserId: string,
    decide: DecideRepricing,
  ): Promise<ApplyRepricingOutcome> {
    const previous = this.records.find((r) => r.key === idempotency.key);
    if (previous) {
      const { key: _key, fingerprint, ...record } = previous;
      return Promise.resolve(
        fingerprint === idempotency.fingerprint
          ? { kind: 'replayed', record }
          : { kind: 'key-reused' },
      );
    }
    const stored = this.plans.get(planId);
    if (stored) this.beforeLock?.(stored);
    if (!stored || stored.patientId !== patientId) {
      throw new NotFoundException('Plan de tratamiento no encontrado');
    }
    const repricing = decide({
      plan: structuredClone(stored),
      facts: { ...this.facts },
    });
    const lines = repricing.lines.map(({ discountDecision, ...line }) =>
      discountDecision?.discountStamp
        ? {
            ...line,
            after: {
              ...line.after,
              discountLocationId: REPRICING_WRITE_LOCATION_ID,
            },
          }
        : line,
    );
    for (const line of lines) {
      const item = stored.items.find((i) => i.id === line.itemId);
      if (!item) throw new Error(`sin ítem ${line.itemId}`);
      const after = line.after;
      Object.assign(item, {
        catalogPrice: after.catalogPrice,
        basePrice: after.basePrice,
        catalogCurrency: after.catalogCurrency,
        priceSource: after.priceSource,
        agreementId: after.agreementId,
        agreementName: after.agreementName,
        pricingLocationId: after.pricingLocationId,
        referenceCurrency: after.reference.referenceCurrency,
        referencePriceInPlan: after.reference.referencePriceInPlan,
        basePriceInPlan: after.reference.basePriceInPlan,
        ...itemRates(after.priceSource, after.reference.referenceRate),
        price: after.price,
        discount: after.discount,
        discountReason: after.discountReason,
        discountReasonNote: after.discountReasonNote,
        discountById: after.discountById,
        discountAt: after.discountAt ? new Date(after.discountAt) : null,
        discountLocationId: after.discountLocationId,
      });
    }
    stored.quoteIssuedOn = repricing.validity.issuedOn;
    stored.quoteValidUntil = repricing.validity.validUntil;
    const record: RepricingRecord = {
      id: `repricing-${++this.seq}`,
      planId,
      patientId,
      locationId: REPRICING_WRITE_LOCATION_ID,
      actorUserId,
      createdAt: new Date('2026-11-09T15:00:00.000Z'),
      previewHash: repricing.previewHash,
      currency: repricing.currency,
      rate: repricing.rate,
      previousValidity: repricing.previousValidity,
      validity: repricing.validity,
      lines,
      skipped: repricing.skipped,
      totals: repricing.totals,
    };
    this.records.push({ ...record, ...idempotency });
    return Promise.resolve({ kind: 'applied', record });
  }
}
