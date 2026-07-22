import { NotFoundException } from '@nestjs/common';
import { DocType, Sex } from '@prisma/client';
import { GetPatientUseCase } from './get-patient.use-case';
import { Patient } from '../../domain/entities/patient.entity';
import {
  CreatePatientRepoInput,
  ListPatientsResult,
  PatientRepository,
} from '../../domain/ports/patient-repository.port';

function fakePatient(id: string): Patient {
  return {
    id,
    tenantId: 't1',
    firstName: 'Ana',
    lastName: 'Gomez',
    docType: DocType.CC,
    docNumber: null,
    birthDate: null,
    sex: Sex.F,
    phone: null,
    email: null,
    address: null,
    notes: null,
    createdById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function makeRepo(
  overrides: Partial<PatientRepository> = {},
): PatientRepository {
  return {
    create: (input: CreatePatientRepoInput): Promise<Patient> =>
      Promise.reject(
        new Error(`not implemented in this fake: create(${JSON.stringify(input)})`),
      ),
    findById: (): Promise<Patient | null> => Promise.resolve(null),
    list: (): Promise<ListPatientsResult> =>
      Promise.resolve({ items: [], total: 0 }),
    update: (): Promise<Patient> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

describe('GetPatientUseCase', () => {
  it('returns the patient when found', async () => {
    const patient = fakePatient('p1');
    const repo = makeRepo({
      findById: (id: string): Promise<Patient | null> =>
        Promise.resolve(id === 'p1' ? patient : null),
    });
    const uc = new GetPatientUseCase(repo);

    const result = await uc.execute('p1');

    expect(result).toBe(patient);
  });

  it('throws NotFoundException when the repository returns null (absent or another tenant)', async () => {
    const repo = makeRepo({
      findById: (): Promise<Patient | null> => Promise.resolve(null),
    });
    const uc = new GetPatientUseCase(repo);

    await expect(uc.execute('missing-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
