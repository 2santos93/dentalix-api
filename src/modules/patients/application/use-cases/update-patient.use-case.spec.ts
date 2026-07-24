import { NotFoundException } from '@nestjs/common';
import { DocType, Sex } from '@prisma/client';
import { UpdatePatientUseCase } from './update-patient.use-case';
import { Patient } from '../../domain/entities/patient.entity';
import {
  CreatePatientRepoInput,
  ListPatientsResult,
  PatientRepository,
  UpdatePatientRepoInput,
} from '../../domain/ports/patient-repository.port';

function fakePatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: 'p1',
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
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<PatientRepository> = {},
): PatientRepository {
  return {
    create: (input: CreatePatientRepoInput): Promise<Patient> =>
      Promise.reject(
        new Error(
          `not implemented in this fake: create(${JSON.stringify(input)})`,
        ),
      ),
    findById: (): Promise<Patient | null> => Promise.resolve(null),
    list: (): Promise<ListPatientsResult> =>
      Promise.resolve({ items: [], total: 0 }),
    update: (): Promise<Patient> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

describe('UpdatePatientUseCase', () => {
  it('updates fields and returns the updated entity', async () => {
    const existing = fakePatient();
    const updated = fakePatient({
      firstName: 'Ana Maria',
      phone: '3001234567',
    });
    let receivedId: string | undefined;
    let receivedPatch: UpdatePatientRepoInput | undefined;
    const repo = makeRepo({
      findById: (id: string): Promise<Patient | null> =>
        Promise.resolve(id === existing.id ? existing : null),
      update: (id: string, patch: UpdatePatientRepoInput): Promise<Patient> => {
        receivedId = id;
        receivedPatch = patch;
        return Promise.resolve(updated);
      },
    });
    const uc = new UpdatePatientUseCase(repo);

    const result = await uc.execute(existing.id, {
      firstName: 'Ana Maria',
      phone: '3001234567',
    });

    expect(result).toBe(updated);
    expect(receivedId).toBe(existing.id);
    expect(receivedPatch).toEqual({
      firstName: 'Ana Maria',
      phone: '3001234567',
    });
  });

  it('throws NotFoundException when the patient does not exist (or belongs to another tenant)', async () => {
    const repo = makeRepo({
      findById: (): Promise<Patient | null> => Promise.resolve(null),
      update: (): Promise<Patient> =>
        Promise.reject(new Error('update should not be called')),
    });
    const uc = new UpdatePatientUseCase(repo);

    await expect(
      uc.execute('missing-id', { firstName: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('normalizes email in the patch when present (trim + lowercase)', async () => {
    const existing = fakePatient();
    let receivedPatch: UpdatePatientRepoInput | undefined;
    const repo = makeRepo({
      findById: (id: string): Promise<Patient | null> =>
        Promise.resolve(id === existing.id ? existing : null),
      update: (
        _id: string,
        patch: UpdatePatientRepoInput,
      ): Promise<Patient> => {
        receivedPatch = patch;
        return Promise.resolve(fakePatient({ email: 'ana@example.com' }));
      },
    });
    const uc = new UpdatePatientUseCase(repo);

    await uc.execute(existing.id, { email: '  Ana@Example.COM  ' });

    expect(receivedPatch?.email).toBe('ana@example.com');
  });
});
