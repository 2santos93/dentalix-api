import type { OrthoCaseStatus, Prisma } from '@prisma/client';
import type {
  OrthoCaseRecord,
  OrthoCaseView,
  OrthoFollowUpFilter,
  OrthoFollowUpRow,
  OrthoSettings,
  OrthoVisitView,
} from '../entities';
import type { OrthoCasePlan, OrthoVisitData } from '../ortho-rules';

export const ORTHO_REPOSITORY = Symbol('ORTHO_REPOSITORY');
export const ORTHO_CLOCK = Symbol('ORTHO_CLOCK');
export type OrthoClock = () => Date;

export interface CreateOrthoCaseRepoInput extends OrthoCasePlan {
  patientId: string;
  locationId: string;
  providerId: string;
  treatmentPlanId: string | null;
  createdById: string;
}

export interface UpdateOrthoCaseRepoInput {
  plan: OrthoCasePlan;
  providerId: string;
  treatmentPlanId: string | null;
}

export interface OrthoStatusChangeRepoInput {
  from: OrthoCaseStatus;
  to: OrthoCaseStatus;
  reason: string | null;
  actorId: string;
}

/** Lo que el control escribe dentro de la transacción de su evolución. */
export interface InsertOrthoVisitInput extends OrthoVisitData {
  patientId: string;
  caseId: string;
  clinicalEntryId: string;
  visitDate: string;
  authorId: string;
}

export interface OrthoFollowUpQuery {
  filter: OrthoFollowUpFilter;
  locationId?: string;
  providerId?: string;
  page: number;
  pageSize: number;
  now: Date;
}

export interface OrthoRepository {
  getSettings(): Promise<OrthoSettings>;
  setSettings(
    next: OrthoSettings,
  ): Promise<{ before: OrthoSettings; after: OrthoSettings }>;

  /** Día civil de hoy en la zona de la sede (`locationId` o la de escritura). */
  today(now: Date, locationId?: string): Promise<string>;
  /** Sede de escritura del contexto (DX-089): la del caso nuevo. */
  writeLocationId(): Promise<string>;
  locationExists(locationId: string): Promise<boolean>;
  /** Rol del miembro VIVO de esta clínica, o null. */
  memberRole(userId: string): Promise<string | null>;
  /** ¿El plan es de esta clínica y de este paciente? */
  planOfPatient(patientId: string, planId: string): Promise<boolean>;

  /** El caso del paciente (de esta clínica), o null. */
  findCase(patientId: string, caseId: string): Promise<OrthoCaseRecord | null>;
  /** Los casos del paciente con progreso y arco actual, el más reciente primero. */
  listCases(patientId: string, now: Date): Promise<OrthoCaseView[]>;
  /** null si ya hay un caso ACTIVE (índice único parcial). */
  createCase(input: CreateOrthoCaseRepoInput): Promise<OrthoCaseRecord | null>;
  updateCase(
    caseId: string,
    input: UpdateOrthoCaseRepoInput,
  ): Promise<OrthoCaseRecord>;
  /** null si el estado ya no era `from` (otro cambio ganó la carrera). */
  changeStatus(
    caseId: string,
    input: OrthoStatusChangeRepoInput,
  ): Promise<OrthoCaseRecord | null>;

  /** Controles del caso con sus adendas, el más reciente primero. */
  listVisits(patientId: string, caseId: string): Promise<OrthoVisitView[]>;
  /**
   * Inserta el control dentro de la transacción de su evolución (`tx`). Vuelve
   * a mirar el estado del caso con la fila bloqueada: `null` si ya no admite
   * controles (y la evolución se deshace con él).
   */
  insertVisit(
    tx: Prisma.TransactionClient,
    input: InsertOrthoVisitInput,
  ): Promise<{ id: string } | null>;
  findVisit(patientId: string, visitId: string): Promise<OrthoVisitView | null>;

  followUp(
    query: OrthoFollowUpQuery,
  ): Promise<{ rows: OrthoFollowUpRow[]; total: number }>;
}
