import { CountPatientsUseCase } from './count-patients.use-case';
import { PatientRepository } from '../../domain/ports/patient-repository.port';

describe('CountPatientsUseCase', () => {
  it('devuelve el conteo del repositorio sin listar pacientes (DB-008)', async () => {
    const list = jest.fn();
    const count = jest.fn().mockResolvedValue(1234);
    const repo = { list, count } as unknown as PatientRepository;

    await expect(new CountPatientsUseCase(repo).execute()).resolves.toBe(1234);
    expect(count).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });
});
