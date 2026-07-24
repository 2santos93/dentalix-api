import {
  ToothSurface,
  TreatmentPlanItemStatus,
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
export interface CreateTreatmentPlanRepoInput {
  patientId: string;
  notes?: string;
  createdById?: string;
}

export interface UpdateTreatmentPlanRepoInput {
  status?: TreatmentPlanStatus;
  notes?: string | null;
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
  notes?: string;
}

export interface UpdateTreatmentPlanItemRepoInput {
  price?: number;
  status?: TreatmentPlanItemStatus;
  surfaces?: ToothSurface[];
  notes?: string | null;
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

  updatePlan(
    id: string,
    patch: UpdateTreatmentPlanRepoInput,
  ): Promise<TreatmentPlan>;

  addItem(input: AddTreatmentPlanItemRepoInput): Promise<TreatmentPlanItem>;

  /** A single active (non-deleted) item, or `null` if absent/soft-deleted. */
  findItemById(id: string): Promise<TreatmentPlanItem | null>;

  updateItem(
    id: string,
    patch: UpdateTreatmentPlanItemRepoInput,
  ): Promise<TreatmentPlanItem>;

  /** Soft-delete: sets `deletedAt`. Never a hard delete. */
  softDeleteItem(id: string): Promise<void>;
}
