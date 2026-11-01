import type {
  NewRecallContact,
  PatientRecallRow,
  RecallContactView,
  RecallDueQuery,
  RecallDueRow,
  SetPatientRecallData,
  StaffRef,
} from '../recall.entity';
import type { RecallKind } from '@prisma/client';

export const RECALL_REPOSITORY = Symbol('RECALL_REPOSITORY');

/** Todo corre bajo RLS (`runWithTenant`) y con el alcance de sede del request. */
export interface RecallRepository {
  /** Lista de llamada: vencidos sin cita en las sedes del request, paginada. */
  listDue(
    query: RecallDueQuery,
  ): Promise<{ rows: RecallDueRow[]; total: number }>;
  patientExists(patientId: string): Promise<boolean>;
  /** Recalls del paciente (con los hechos del vencimiento) y su historial de contactos. */
  patientRecalls(
    patientId: string,
    now: Date,
  ): Promise<{ rows: PatientRecallRow[]; contacts: RecallContactView[] }>;
  /** Hoy en la zona de la sede donde se escribe (la activa o la de trabajo). */
  writeToday(now: Date): Promise<string>;
  upsertRecall(data: SetPatientRecallData): Promise<{ id: string }>;
  findRecall(
    recallId: string,
  ): Promise<{ id: string; patientId: string; kind: RecallKind } | null>;
  appointmentOfPatient(
    appointmentId: string,
    patientId: string,
  ): Promise<boolean>;
  createContact(data: NewRecallContact): Promise<RecallContactView>;
  staff(ids: readonly string[]): Promise<Map<string, StaffRef>>;
}
