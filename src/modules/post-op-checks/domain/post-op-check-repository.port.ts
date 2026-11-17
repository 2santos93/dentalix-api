import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import type {
  PostOpAttemptOutcomeCode,
  PostOpCheckOutcomeCode,
  PostOpCheckStatusCode,
} from './post-op-check-rules';

export const POST_OP_CHECK_REPOSITORY = Symbol('POST_OP_CHECK_REPOSITORY');

/** Qué controles PENDING entran en la lista. */
export interface PostOpCheckScope {
  /** Sedes a las que se acota; `undefined` = todas (sin restricción). */
  locationIds: string[] | undefined;
  /** true: solo los que vencen hoy; false: hoy y los vencidos. */
  onlyToday: boolean;
  /** «Ahora» del servidor: «hoy» es su día civil en la zona de cada sede. */
  now: Date;
}

export interface PostOpCheckAttemptRow {
  id: string;
  outcome: PostOpAttemptOutcomeCode;
  note: string | null;
  byId: string;
  byName: string;
  at: Date;
}

export interface PostOpInstructionRow {
  deliveryId: string;
  title: string;
  deliveredAt: Date;
}

/** Una fila de la lista, con todo (el caso de uso recorta por rol). */
export interface PostOpCheckRow {
  id: string;
  status: PostOpCheckStatusCode;
  dueOn: string;
  /** Hoy en la zona de la sede del control. */
  today: string;
  locationId: string;
  patientId: string;
  patientName: string;
  patientPhone: string | null;
  phoneRegion: string | null;
  professionalId: string;
  professionalName: string | null;
  appointmentId: string | null;
  appointmentStart: Date | null;
  procedureName: string;
  attempts: PostOpCheckAttemptRow[];
  instructions: PostOpInstructionRow[];
}

export interface PostOpCheckPage {
  rows: PostOpCheckRow[];
  total: number;
  overdue: number;
}

export interface PostOpCheckCount {
  total: number;
  overdue: number;
}

/** El control tal como queda tras registrar un intento. */
export interface PostOpCheckState {
  id: string;
  patientId: string;
  locationId: string;
  status: PostOpCheckStatusCode;
  outcome: PostOpCheckOutcomeCode | null;
  dueOn: string;
  closedAt: Date | null;
  closedById: string | null;
  clinicalEntryId: string | null;
  addendumId: string | null;
  attemptId: string;
  attemptsCount: number;
}

export interface RecordAttemptInput {
  checkId: string;
  outcome: PostOpAttemptOutcomeCode;
  note: string | null;
  actorId: string;
}

/** Lo que el repositorio necesita saber antes de escribir (bajo el bloqueo). */
export interface LockedPostOpCheck {
  id: string;
  patientId: string;
  locationId: string;
  status: PostOpCheckStatusCode;
  noAnswers: number;
}

export interface PostOpCheckRepository {
  list(
    scope: PostOpCheckScope,
    page: { page: number; pageSize: number },
  ): Promise<PostOpCheckPage>;
  count(scope: PostOpCheckScope): Promise<PostOpCheckCount>;
  /**
   * En UNA transacción: bloquea el control (FOR UPDATE), deja que `decide`
   * compruebe la sede y el estado y decida, añade el intento y, si se cierra,
   * deja la adenda o la evolución nueva y cierra el control; audita UPDATE
   * POST_OP_CHECK en la misma transacción. null si no existe en esta clínica.
   */
  recordAttempt(
    input: RecordAttemptInput,
    decide: (locked: LockedPostOpCheck) =>
      | { close: false }
      | {
          close: true;
          status: 'DONE' | 'UNREACHABLE';
          outcome: PostOpCheckOutcomeCode | null;
        },
    audit: AuditRequestContext,
  ): Promise<PostOpCheckState | null>;
}
