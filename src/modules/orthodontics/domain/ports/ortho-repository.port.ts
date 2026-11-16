import type {
  OrthoAlignerArch,
  OrthoCaseStatus,
  OrthoTechnique,
  Prisma,
} from '@prisma/client';
import type {
  OrthoAccountPaymentPlan,
  OrthoAlignerSeriesView,
  OrthoBalanceFlag,
  OrthoCaseRecord,
  OrthoCaseView,
  OrthoFollowUpFilter,
  OrthoFollowUpRow,
  OrthoSettings,
  OrthoVisitView,
} from '../entities';
import type { OrthoCasePlan, OrthoVisitData } from '../ortho-rules';
import type {
  AlignerDelivery,
  ChargeFacts,
  OrthoFeeSplit,
} from '../ortho-billing';

type Result<T> = { ok: true; value: T } | { ok: false; message: string };

/** DX-285: la moneda que tomaría el honorario. */
export interface OrthoFeeCurrencySource {
  /** La del plan ligado, si lo hay. */
  planCurrency: string | null;
  /** La de la sede del caso (GLOBAL-G1; NULL solo en sedes antiguas). */
  locationCurrency: string | null;
}

export type AcceptOrthoFeeOutcome =
  | {
      outcome: 'OK';
      planId: string;
      chargesCreated: number;
      paymentPlanId: string | null;
    }
  | {
      outcome:
        | 'NOT_FOUND'
        | 'CLOSED'
        | 'NO_FEE'
        | 'ALREADY_ACCEPTED'
        | 'PLAN_NOT_ACCEPTED'
        | 'PLAN_SIGNED'
        | 'PLAN_CLOSED'
        | 'PLAN_CURRENCY'
        | 'NO_CURRENCY';
    };

export interface AcceptOrthoFeeInput {
  patientId: string;
  caseId: string;
  actorId: string;
  technique: OrthoTechnique;
}

/** Los hechos de la cuenta de un caso, en UNA lectura. */
export interface OrthoAccountFacts {
  today: string;
  visitsDone: number;
  charges: ChargeFacts[];
  paymentPlan: OrthoAccountPaymentPlan | null;
}

export interface CreateAlignerSeriesInput {
  caseId: string;
  arch: OrthoAlignerArch;
  brand: string;
  totalTrays: number;
  daysPerTray: number;
  refinementOfId: string | null;
  createdById: string;
}

export interface AddAlignerDeliveryInput {
  caseId: string;
  seriesId: string;
  visitId: string | null;
  createdById: string;
  /** Valida la entrega con la serie y las anteriores, leídas con el caso bloqueado. */
  validate: (
    series: { totalTrays: number },
    previous: AlignerDelivery[],
  ) => Result<AlignerDelivery>;
}

export type AddAlignerDeliveryOutcome =
  | { outcome: 'OK'; id: string }
  | { outcome: 'SERIES_NOT_FOUND' | 'CASE_CLOSED' }
  | { outcome: 'INVALID'; message: string };

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

  // -- DX-285: honorario y cuenta

  feeCurrencySource(caseId: string): Promise<OrthoFeeCurrencySource>;
  /** null si el honorario ya estaba aceptado (otro lo aceptó a la vez). */
  setFee(
    caseId: string,
    fee: { split: OrthoFeeSplit; currency: string } | null,
    actorId: string,
  ): Promise<OrthoCaseRecord | null>;
  /**
   * En UNA transacción con el caso bloqueado: crea los ítems en el plan
   * ligado (o en uno nuevo «Ortodoncia»), los cargos, realiza la inicial y
   * los controles ya registrados, y marca el honorario aceptado. Con cuotas
   * ACTIVE en el plan ligado no crea cargos: solo apunta las cuotas.
   */
  acceptFee(input: AcceptOrthoFeeInput): Promise<AcceptOrthoFeeOutcome>;
  accountFacts(
    patientId: string,
    caseId: string,
    now: Date,
  ): Promise<OrthoAccountFacts | null>;
  /** Casos con honorario del paciente (para recepción, sin datos clínicos). */
  casesWithFee(patientId: string): Promise<OrthoCaseRecord[]>;
  /** El cargo del siguiente control sin realizar pasa a hecho (en `tx`). */
  realizeVisitCharge(
    tx: Prisma.TransactionClient,
    input: { caseId: string; visitId: string; authorId: string },
  ): Promise<void>;
  /** Marca «Ortodoncia: saldo vencido» de un lote de pacientes, una consulta. */
  overdueFlags(
    patientIds: readonly string[],
    now: Date,
  ): Promise<Map<string, OrthoBalanceFlag>>;

  // -- DX-285: alineadores

  listAlignerSeries(
    caseId: string,
    today: string,
  ): Promise<OrthoAlignerSeriesView[]>;
  seriesOfCase(caseId: string, seriesId: string): Promise<boolean>;
  visitOfCase(
    caseId: string,
    visitId: string,
  ): Promise<{ visitDate: string } | null>;
  createAlignerSeries(input: CreateAlignerSeriesInput): Promise<{ id: string }>;
  addAlignerDelivery(
    input: AddAlignerDeliveryInput,
  ): Promise<AddAlignerDeliveryOutcome>;
}
