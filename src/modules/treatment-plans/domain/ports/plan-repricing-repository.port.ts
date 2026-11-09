import type { TreatmentPlanWithItems } from '../entities/treatment-plan.entity';
import type { PlanFacts } from './treatment-plan-repository.port';
import type {
  Repricing,
  RepricingLine,
  RepricingRate,
  RepricingSkip,
} from '../../application/repricing';
import type { QuoteValidity } from '../quote-validity';

export const PLAN_REPRICING_REPOSITORY = Symbol('PLAN_REPRICING_REPOSITORY');

/** El plan (con sus ítems vivos y su aceptación) y lo que no lleva su detalle. */
export interface RepricingSubject {
  plan: TreatmentPlanWithItems;
  facts: PlanFacts;
}

/** Una línea tal como queda guardada (sin la decisión del descuento). */
export type StoredRepricingLine = Omit<RepricingLine, 'discountDecision'>;

/** Una recotización aplicada (fila de `treatment_plan_repricings`). */
export interface RepricingRecord {
  id: string;
  planId: string;
  patientId: string;
  locationId: string;
  actorUserId: string;
  createdAt: Date;
  previewHash: string;
  currency: string;
  rate: RepricingRate | null;
  previousValidity: QuoteValidity | null;
  /** I-1: ¿se renovó la validez? (todos los propuestos recotizados). */
  validityRenewed: boolean;
  validityNote: string | null;
  /** La validez con la que quedó el plan: la nueva o la que ya tenía. */
  validity: QuoteValidity | null;
  lines: StoredRepricingLine[];
  skipped: RepricingSkip[];
  totals: { before: number; after: number };
}

/** La clave de la cabecera Idempotency-Key y la huella de la petición. */
export interface RepricingIdempotency {
  key: string;
  fingerprint: string;
}

export type ApplyRepricingOutcome =
  | { kind: 'applied'; record: RepricingRecord }
  /** Misma clave y misma petición: la recotización ya aplicada. */
  | { kind: 'replayed'; record: RepricingRecord }
  /** Misma clave con otra petición (otro plan, otra vista previa u otros ítems). */
  | { kind: 'key-reused' };

/**
 * Decide la recotización con el plan BLOQUEADO (su grupo FOR UPDATE) y
 * releído en la transacción: valida el estado y la huella y devuelve lo que
 * se escribe. Si lanza, no se escribe nada.
 */
export type DecideRepricing = (subject: RepricingSubject) => Repricing;

export interface PlanRepricingRepository {
  /**
   * El plan `planId` del paciente `patientId` (ítems vivos y aceptación) con
   * sus hechos (abonos, plan de cuotas, saldo a favor), sin bloquear. `null`
   * si no existe, está retirado, es de otro paciente o de otra clínica.
   */
  load(patientId: string, planId: string): Promise<RepricingSubject | null>;

  /**
   * La recotización ya aplicada con esta clave (`replayed` si es la misma
   * petición, `key-reused` si es otra), o `null` si la clave es nueva. Se
   * mira antes de leer precios: una repetición devuelve lo aplicado aunque el
   * plan haya cambiado después. `apply` lo vuelve a mirar con el candado.
   */
  findApplied(
    idempotency: RepricingIdempotency,
  ): Promise<Exclude<ApplyRepricingOutcome, { kind: 'applied' }> | null>;

  /**
   * Aplica en UNA transacción: espera a otra petición con la misma clave
   * (candado por clave), devuelve la ya aplicada si la clave existe (o
   * `key-reused` si era de otra petición), bloquea el plan y su grupo, lo
   * relee, deja que `decide` calcule y escribe los ítems (con la marca
   * `app.plan_item_reprice`), la validez nueva del plan y la fila de la
   * recotización. 404 si el plan no existe o es de otro paciente.
   */
  apply(
    patientId: string,
    planId: string,
    idempotency: RepricingIdempotency,
    actorUserId: string,
    decide: DecideRepricing,
  ): Promise<ApplyRepricingOutcome>;
}
