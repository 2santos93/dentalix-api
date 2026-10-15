import type { PatientRepository } from '../../domain/ports/patient-repository.port';

/**
 * Doble del repositorio de pacientes para los use-cases que solo necesitan
 * preguntar "¿este paciente es de ESTA clínica?". `findById` devuelve un
 * paciente solo para los ids dados: cualquier otro se comporta como lo haría
 * bajo RLS un paciente inexistente o de otro tenant (null).
 */
export function patientsInClinic(...ids: string[]): PatientRepository {
  const known = new Set(ids);
  return {
    findById: (id: string): Promise<never> =>
      Promise.resolve(known.has(id) ? { id } : null) as Promise<never>,
  } as unknown as PatientRepository;
}
