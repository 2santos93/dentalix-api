import { GetMedicalHistoryUseCase } from './get-medical-history.use-case';
import { MedicalHistory } from '../../domain/entities/medical-history.entity';
import { MedicalHistoryRepository } from '../../domain/ports/medical-history-repository.port';

function fakeVersion(
  patientId: string,
  version: number,
  overrides: Partial<MedicalHistory> = {},
): MedicalHistory {
  return {
    id: `mh-${patientId}-${version}`,
    tenantId: 't1',
    patientId,
    version,
    allergies: null,
    chronicConditions: null,
    currentMedications: null,
    habits: null,
    medicalAlerts: null,
    notes: null,
    createdById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<MedicalHistoryRepository> = {},
): MedicalHistoryRepository {
  return {
    getLatest: (): Promise<MedicalHistory | null> => Promise.resolve(null),
    createVersion: (): Promise<MedicalHistory> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

describe('GetMedicalHistoryUseCase', () => {
  it('returns null when the patient has no medical history versions', async () => {
    const repo = makeRepo();
    const uc = new GetMedicalHistoryUseCase(repo);

    const result = await uc.execute('p1');

    expect(result).toBeNull();
  });

  it('returns the highest-version row when multiple versions exist (delegates to repo.getLatest)', async () => {
    const v3 = fakeVersion('p1', 3, { notes: 'latest' });
    const repo = makeRepo({
      getLatest: (patientId: string): Promise<MedicalHistory | null> =>
        Promise.resolve(patientId === 'p1' ? v3 : null),
    });
    const uc = new GetMedicalHistoryUseCase(repo);

    const result = await uc.execute('p1');

    expect(result).toBe(v3);
    expect(result?.version).toBe(3);
  });

  it('scopes by patientId (returns null for a patient with no versions even if another patient has some)', async () => {
    const repo = makeRepo({
      getLatest: (patientId: string): Promise<MedicalHistory | null> =>
        Promise.resolve(patientId === 'p1' ? fakeVersion('p1', 1) : null),
    });
    const uc = new GetMedicalHistoryUseCase(repo);

    const result = await uc.execute('p2');

    expect(result).toBeNull();
  });
});
