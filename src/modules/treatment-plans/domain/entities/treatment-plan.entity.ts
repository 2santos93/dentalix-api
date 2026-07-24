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
  notes: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Returned by `TreatmentPlanRepository.findPlanById` — the plan plus its
 * active (non-deleted) items. There is no `total` here: computing it is the
 * use case's job, not the repository's (see `TreatmentPlanDetail`).
 */
export interface TreatmentPlanWithItems extends TreatmentPlan {
  items: TreatmentPlanItem[];
}

/**
 * Returned by `GetTreatmentPlanUseCase` — plan + active items + `total`
 * (the sum of `items[].price`, computed on the fly, NEVER stored on the
 * plan row).
 */
export interface TreatmentPlanDetail extends TreatmentPlanWithItems {
  total: number;
}
