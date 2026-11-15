import { NotFoundException } from '@nestjs/common';
import { Sex } from '@prisma/client';
import { GetPatientUseCase, PATIENT_MERGED } from './get-patient.use-case';
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
    patientCode: '1',
    firstName: 'Ana',
    lastName: 'Gomez',
    docType: 'NATIONAL_ID',
    docTypeLabel: null,
    docNumber: null,
    birthDate: null,
    sex: Sex.F,
    phone: null,
    email: null,
    address: null,
    countryCode: null,
    cityId: null,
    notes: null,
    dataConsentAccepted: false,
    dataConsentAt: null,
    dataConsentPolicyVersion: null,
    maritalStatus: null,
    occupation: null,
    physicianName: null,
    physicianPhone: null,
    emergencyContactName: null,
    emergencyContactRelationship: null,
    emergencyContactPhone: null,
    guardianName: null,
    guardianDocNumber: null,
    createdById: null,
    lastAttentionAt: null,
    retentionExtended: 'NONE',
    retentionUntil: null,
    underRetention: false,
    clinicRetentionYears: 15,
    retentionFromPreviousTerm: false,
    partiallySuppressedAt: null,
    importBatchId: null,
    contactChannel: 'EMAIL',
    preferredLanguage: null,
    whatsappOptInAt: null,
    whatsappOptInSource: null,
    whatsappOptInById: null,
    reminderOptOutAt: null,
    reminderOptOutSource: null,
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
        new Error(
          `not implemented in this fake: create(${JSON.stringify(input)})`,
        ),
      ),
    findById: (): Promise<Patient | null> => Promise.resolve(null),
    list: (): Promise<ListPatientsResult> =>
      Promise.resolve({ items: [], total: 0 }),
    count: (): Promise<number> => Promise.resolve(0),
    archive: (): Promise<void> =>
      Promise.reject(new Error('not implemented in this fake')),
    setRetentionExtension: (): Promise<Patient> =>
      Promise.reject(new Error('not implemented in this fake')),
    partiallySuppress: (): Promise<Patient> =>
      Promise.reject(new Error('not implemented in this fake')),
    listRetentionExpiring: (): Promise<ListPatientsResult> =>
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

describe('GetPatientUseCase — paciente fusionado (DX-266)', () => {
  it('un absorbido responde 404 con el código y el paciente que se conserva', async () => {
    const repo = makeRepo({
      findMergedInto: (id: string) =>
        Promise.resolve(id === 'absorbido' ? 'conservado' : null),
    });
    const error = await new GetPatientUseCase(repo)
      .execute('absorbido')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      code: PATIENT_MERGED,
      mergedIntoId: 'conservado',
    });
  });

  it('uno que no existe (o de otra clínica) sigue siendo el 404 de siempre, sin pistas', async () => {
    const repo = makeRepo({ findMergedInto: () => Promise.resolve(null) });
    const error = await new GetPatientUseCase(repo)
      .execute('nadie')
      .catch((e: unknown) => e);
    expect((error as NotFoundException).getResponse()).toMatchObject({
      message: 'Paciente no encontrado',
    });
    expect(
      JSON.stringify((error as NotFoundException).getResponse()),
    ).not.toContain('mergedIntoId');
  });
});
