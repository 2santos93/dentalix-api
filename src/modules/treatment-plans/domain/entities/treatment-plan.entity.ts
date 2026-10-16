import { TreatmentPlanStatus } from '@prisma/client';
import { TreatmentPlanItem } from './treatment-plan-item.entity';

/**
 * API-facing shape of a TreatmentPlan. Deliberately NOT the raw Prisma model
 * — same convention as Appointment/DentalCatalogItem. The bare CRUD
 * operations (`createPlan`/`updatePlan`/`listPlansByPatient`) return this
 * shape, with no items attached.
 */
export interface TreatmentPlan {
  id: string;
  tenantId: string;
  patientId: string;
  status: TreatmentPlanStatus;
  // Moneda del plan (PAY-T1: `TreatmentPlan.currency`, default "USD" at the
  // schema level). Monto a pagar/saldo se calculan en esta moneda -- ver
  // `GetPlanBalanceUseCase` (payments module).
  currency: string;
  notes: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Quién aceptó con firma el presupuesto del plan y cuándo (DX-012). */
export interface TreatmentPlanAcceptanceSummary {
  signerName: string;
  acceptedAt: Date;
}

/**
 * Returned by `TreatmentPlanRepository.findPlanById` — the plan plus its
 * active (non-deleted) items. There is no `total` here: computing it is the
 * use case's job, not the repository's (see `TreatmentPlanDetail`).
 * `acceptance` no es `null` cuando el plan se aceptó con firma: entonces sus
 * ítems quedan congelados (DX-012).
 */
export interface TreatmentPlanWithItems extends TreatmentPlan {
  items: TreatmentPlanItem[];
  acceptance: TreatmentPlanAcceptanceSummary | null;
}

/**
 * Returned by `GetTreatmentPlanUseCase` — plan + active items + `total`
 * (the sum of `items[].price - items[].discount`, computed on the fly, NEVER
 * stored on the plan row).
 */
export interface TreatmentPlanDetail extends TreatmentPlanWithItems {
  total: number;
}
