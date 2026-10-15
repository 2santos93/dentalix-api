import { NotFoundException } from '@nestjs/common';
import type { PatientRepository } from '../domain/ports/patient-repository.port';

export const PATIENT_NOT_FOUND_MESSAGE = 'Paciente no encontrado';

/**
 * Exige que `patientId` sea un paciente vivo de la clínica EN CONTEXTO antes de
 * escribir algo que lo referencie. `PatientRepository.findById` corre bajo RLS,
 * así que un paciente de otro tenant devuelve null igual que uno inexistente:
 * ambos dan el mismo 404, sin revelar si el UUID existe en otra clínica.
 *
 * Es la capa de aplicación de SEC-004. La capa DB son las FK compuestas
 * `(tenantId, patientId) -> patients(tenantId, id)`, que lo hacen imposible
 * aunque una ruta futura se salte el use-case; esta capa da el 404 limpio en
 * vez de un 500 por violación de FK.
 */
export async function assertPatientInClinic(
  patients: PatientRepository,
  patientId: string,
): Promise<void> {
  const patient = await patients.findById(patientId);
  if (!patient) {
    throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
  }
}
