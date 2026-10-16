import {
  CatalogKind,
  ToothSurface,
  TreatmentPlanItemStatus,
  TreatmentPlanRejectionReason,
  TreatmentPlanStatus,
} from '@prisma/client';
import {
  TreatmentPlan,
  TreatmentPlanWithItems,
} from '../entities/treatment-plan.entity';
import { TreatmentPlanItem } from '../entities/treatment-plan-item.entity';

// NOTE: deliberately NO `tenantId`/`id`/`status` field — the tenant comes
// from the guarded request context (never the client, same convention as
// CreateAppointmentRepoInput). `status` always starts at the schema default
// (DRAFT) on create; there is no way to create a plan in any other status.
// `currency` arrives here ALREADY resolved (default "USD" applied) and
// whitelist-validated by CreateTreatmentPlanUseCase — the repo never
// defaults or validates it.
export interface CreateTreatmentPlanRepoInput {
  patientId: string;
  currency: string;
  notes?: string;
  createdById?: string;
}

// `currency`, like `status`/`notes`, is only present here when the caller
// wants to change it — UpdateTreatmentPlanUseCase whitelist-validates it
// BEFORE it reaches the repo, only when provided. The status fields arrive
// already validated against the state machine (DX-040,
// `domain/plan-status-machine.ts`).
export interface UpdateTreatmentPlanRepoInput {
  status?: TreatmentPlanStatus;
  currency?: string;
  notes?: string | null;
  optionLabel?: string | null;
  /**
   * Presentar (DX-040): fija `presentedAt` y `presentedLocationId`, que el
   * repositorio toma de la sede del request (`X-Location-Id`) o, en la vista
   * consolidada, de la principal.
   */
  presentation?: { at: Date };
  /** Rechazar (DX-040): cuándo, por qué y la nota. */
  rejection?: {
    at: Date;
    reason: TreatmentPlanRejectionReason;
    note: string | null;
  };
  /**
   * Aceptar (DX-040): con este campo la escritura ACEPTA la opción, y el
   * repositorio rechaza en la MISMA transacción a sus hermanas abiertas del
   * grupo (motivo OTHER_OPTION_ACCEPTED, a esta hora). 409 si otra opción del
   * grupo ya estaba aceptada, o si una hermana que habría que rechazar tiene
   * abonos vivos o procedimientos realizados.
   */
  acceptedAt?: Date;
}

/**
 * Decide el cambio a partir del plan LEÍDO CON SU GRUPO BLOQUEADO (FOR UPDATE):
 * así la validación (transición, ítems, firma) y la escritura ven el mismo
 * estado aunque haya otra petición sobre el plan o sus hermanas. Si lanza, no
 * se escribe nada.
 */
export type DecidePlanChange = (
  current: TreatmentPlanWithItems,
  facts: PlanFacts,
) => UpdateTreatmentPlanRepoInput;

/** Lo que el plan no lleva en su detalle y algunas decisiones necesitan. */
export interface PlanFacts {
  /** ¿Tiene abonos vivos (ni retirados ni anulados)? */
  hasLivePayments: boolean;
}

// NOTE: deliberately NO `tenantId`/`id`/`status` field — a newly added item
// always starts PROPOSED (the schema default). `price` is REQUIRED here: the
// use case is the one that resolves "explicit price vs. catalog
// defaultPrice vs. price-required error" BEFORE calling the repository, so
// by the time this input reaches the repo the price is always resolved.
export interface AddTreatmentPlanItemRepoInput {
  planId: string;
  toothNumber: string;
  surfaces?: ToothSurface[];
  catalogItemId: string;
  price: number;
  /** Ya validado (0 ≤ discount ≤ price) por el caso de uso; 0 si se omite. */
  discount?: number;
  notes?: string;
}

export interface UpdateTreatmentPlanItemRepoInput {
  price?: number;
  discount?: number;
  status?: TreatmentPlanItemStatus;
  surfaces?: ToothSurface[];
  notes?: string | null;
}

/**
 * Lo que el espejo DONE → odontograma (Pieza B) necesita y el ítem no guarda:
 * el paciente (vía el plan), el `kind` (vía el catálogo) y quién lo hizo. El
 * diente, las superficies y el ítem de catálogo salen del propio ítem ya
 * actualizado.
 */
export interface DoneMirrorInput {
  patientId: string;
  kind: CatalogKind;
  performedById?: string;
}

export const TREATMENT_PLAN_REPOSITORY = Symbol('TREATMENT_PLAN_REPOSITORY');

export interface TreatmentPlanRepository {
  createPlan(input: CreateTreatmentPlanRepoInput): Promise<TreatmentPlan>;

  /**
   * The plan plus its active (non-deleted) items, or `null` if the plan is
   * absent, soft-deleted, or belongs to another tenant (RLS makes those
   * indistinguishable from "absent").
   */
  findPlanById(id: string): Promise<TreatmentPlanWithItems | null>;

  /** Active plans for the patient, ordered by `createdAt` DESC. */
  listPlansByPatient(patientId: string): Promise<TreatmentPlan[]>;

  /**
   * Cambia el plan en UNA transacción: bloquea el plan y su grupo de opciones
   * (en orden de id, para que dos aceptaciones del mismo grupo no se bloqueen
   * en cruz), relee el plan, deja que `decide` valide y calcule el cambio, y
   * lo aplica (con `acceptedAt`, rechazando también a las hermanas). 404 si el
   * plan no existe o es de otra clínica.
   */
  updatePlan(id: string, decide: DecidePlanChange): Promise<TreatmentPlan>;

  addItem(input: AddTreatmentPlanItemRepoInput): Promise<TreatmentPlanItem>;

  /** A single active (non-deleted) item, or `null` if absent/soft-deleted. */
  findItemById(id: string): Promise<TreatmentPlanItem | null>;

  /**
   * Actualiza el ítem (404 si no existe o está retirado). Con `mirror`, si
   * ESTE cambio lo lleva a DONE, inserta en la MISMA transacción su registro
   * COMPLETED en el odontograma, enlazado por `sourcePlanItemId` (DX-042,
   * DB-013). El estado previo se lee con la fila bloqueada (FOR UPDATE): dos
   * PATCH DONE concurrentes se serializan y solo el primero espeja. Si el
   * espejo falla, falla todo: nunca queda un ítem DONE sin su registro
   * clínico. El odontograma es append-only: solo se inserta, nunca se cambia.
   */
  updateItem(
    id: string,
    patch: UpdateTreatmentPlanItemRepoInput,
    mirror?: DoneMirrorInput,
  ): Promise<TreatmentPlanItem>;

  /** Soft-delete: sets `deletedAt`. Never a hard delete. */
  softDeleteItem(id: string): Promise<void>;
}
