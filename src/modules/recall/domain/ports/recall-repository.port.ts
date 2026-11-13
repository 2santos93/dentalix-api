import type { RecallKind } from '@prisma/client';
import type {
  NewRecallContact,
  PatientRecallRow,
  RecallContactView,
  RecallDueQuery,
  RecallDueRow,
  RecallRef,
  RecallTypeRef,
  RecallTypeView,
  RecallUnconfiguredQuery,
  RecallUnconfiguredRow,
  NewRecallType,
  RecallExclusionUpdate,
  RecallTypeFields,
  SetPatientRecallData,
  StaffRef,
} from '../recall.entity';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

export const RECALL_REPOSITORY = Symbol('RECALL_REPOSITORY');

/** Todo corre bajo RLS (`runWithTenant`) y con el alcance de sede del request. */
export interface RecallRepository {
  /** Lista de llamada: vencidos sin cita en las sedes del request, paginada. */
  listDue(
    query: RecallDueQuery,
  ): Promise<{ rows: RecallDueRow[]; total: number }>;
  /**
   * D17: pacientes vivos con una cita atendida en los últimos 24 meses, sin
   * ningún recall activo de un tipo vivo y sin próxima cita, paginada.
   */
  listUnconfigured(
    query: RecallUnconfiguredQuery,
  ): Promise<{ rows: RecallUnconfiguredRow[]; total: number }>;
  patientExists(patientId: string): Promise<boolean>;
  /** Recalls del paciente (con los hechos del vencimiento) y su historial de contactos. */
  patientRecalls(
    patientId: string,
    now: Date,
  ): Promise<{ rows: PatientRecallRow[]; contacts: RecallContactView[] }>;
  /** Hoy en la zona de la sede donde se escribe (la activa o la de trabajo). */
  writeToday(now: Date): Promise<string>;
  /**
   * Crea o cambia el recall del tipo y recalcula su base; si queda activo por
   * un alta o una reactivación, aplica la exclusión (D9). Misma transacción.
   */
  upsertRecall(
    data: SetPatientRecallData,
  ): Promise<{ id: string; excluded: RecallExclusionUpdate[] }>;
  /**
   * D15: alta de un recall con el intervalo por defecto del tipo y la base en
   * la última cita atendida (o hoy). 422 si el tipo no está vivo y activo,
   * 409 si ya hay uno de ese tipo. Aplica la exclusión (D9) y se audita.
   */
  createDefaultRecall(data: {
    patientId: string;
    recallTypeId: string;
    /**
     * La cita que se despide (viva, del paciente, en ARRIVED, IN_CHAIR,
     * READY_FOR_CHECKOUT o COMPLETED; si no, 422): su día civil y su sede.
     */
    appointmentId?: string;
    now: Date;
    actorId: string;
    audit?: AuditRequestContext;
  }): Promise<{ id: string; excluded: RecallExclusionUpdate[] }>;
  /** DX-015-bis: el tipo vivo por su clave del enum o por su id. */
  findType(
    ref: { systemKey: RecallKind } | { id: string },
  ): Promise<RecallTypeRef | null>;
  /** DX-015-bis: los tipos vivos de la clínica, en su orden. */
  listTypes(): Promise<RecallTypeView[]>;
  /** DX-015-bis (porción 2): un tipo vivo de la clínica, con sus disparadores. */
  findTypeView(id: string): Promise<RecallTypeView | null>;
  /**
   * Alta de un tipo con su evento RECALL_TYPE (misma transacción). 409 si el
   * nombre choca con otro vivo (sin distinguir mayúsculas).
   */
  createType(
    data: NewRecallType,
    audit: AuditRequestContext,
  ): Promise<RecallTypeView>;
  /** Edición (solo los campos presentes), con el diff en la auditoría. 409 por nombre. */
  updateType(
    id: string,
    data: Partial<RecallTypeFields>,
    audit: AuditRequestContext,
  ): Promise<RecallTypeView>;
  /** Borrado lógico (y desactivado), auditado. */
  retireType(id: string, audit: AuditRequestContext): Promise<void>;
  /**
   * Reemplaza los disparadores (auditado con el antes y el después). 422 si
   * algún id no es un procedimiento vivo de la clínica ni un disparador que
   * el tipo ya tenía.
   */
  setTriggers(
    id: string,
    catalogItemIds: readonly string[],
    audit: AuditRequestContext,
  ): Promise<RecallTypeView>;
  /** El recall con su sede: la misma que usa la lista para filtrar. */
  findRecall(recallId: string): Promise<RecallRef | null>;
  appointmentOfPatient(
    appointmentId: string,
    patientId: string,
  ): Promise<boolean>;
  createContact(data: NewRecallContact): Promise<RecallContactView>;
  staff(ids: readonly string[]): Promise<Map<string, StaffRef>>;
}
