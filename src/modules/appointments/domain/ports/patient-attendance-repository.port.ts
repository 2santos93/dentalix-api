import type { LocationAttendance, PatientIncidentCounts } from '../attendance';

export const PATIENT_ATTENDANCE_REPOSITORY = Symbol(
  'PATIENT_ATTENDANCE_REPOSITORY',
);

/**
 * DX-279. `locationIds`: las sedes permitidas al usuario (DX-089);
 * `undefined` = todas. Sin `tenantId`: sale del contexto (RLS).
 */
export interface PatientAttendanceRepository {
  /** ¿El paciente existe (vivo) en esta clínica? */
  patientExists(patientId: string): Promise<boolean>;

  /**
   * Inasistencias y cancelaciones tardías de un LOTE de pacientes desde
   * `since`, en UNA consulta (la agenda, sin N+1). Los pacientes sin
   * incidencias no salen en el mapa.
   */
  countsByPatients(
    patientIds: readonly string[],
    since: Date,
    locationIds: readonly string[] | undefined,
  ): Promise<Map<string, PatientIncidentCounts>>;

  /** El resumen del paciente por sede desde `since` (orden por nombre). */
  summaryByLocation(
    patientId: string,
    since: Date,
    until: Date,
    locationIds: readonly string[] | undefined,
  ): Promise<LocationAttendance[]>;
}
