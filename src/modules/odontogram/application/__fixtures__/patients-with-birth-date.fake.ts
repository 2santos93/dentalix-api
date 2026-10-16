import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';

/**
 * Doble del repositorio de pacientes con fecha de nacimiento (DX-120): la
 * dentición por defecto sale de la edad. Un id que no está es, como bajo RLS,
 * un paciente inexistente o de otra clínica (null).
 */
export function patientsWithBirthDate(
  byId: Record<string, string | null>,
): PatientRepository {
  return {
    findById: (id: string): Promise<never> =>
      Promise.resolve(
        id in byId
          ? {
              id,
              birthDate: byId[id]
                ? new Date(`${byId[id]}T00:00:00.000Z`)
                : null,
            }
          : null,
      ) as Promise<never>,
  } as unknown as PatientRepository;
}
