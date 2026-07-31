import { DocType, Sex } from '@prisma/client';
import { ListPatientsUseCase } from './list-patients.use-case';
import { Patient } from '../../domain/entities/patient.entity';
import {
  CreatePatientRepoInput,
  ListPatientsParams,
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
    countryCode: null,
    cityId: null,
    notes: null,
    dataConsentAccepted: false,
    dataConsentAt: null,
    dataConsentPolicyVersion: null,
    maritalStatus: null,
    occupation: null,
    insurerEps: null,
    physicianName: null,
    physicianPhone: null,
    emergencyContactName: null,
    emergencyContactRelationship: null,
    emergencyContactPhone: null,
    guardianName: null,
    guardianDocNumber: null,
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

describe('ListPatientsUseCase', () => {
  it('applies default page=1 and pageSize=20 when not provided', async () => {
    let captured: ListPatientsParams | undefined;
    const repo = makeRepo({
      list: (params) => {
        captured = params;
        return Promise.resolve({ items: [], total: 0 });
      },
    });
    const uc = new ListPatientsUseCase(repo);

    const result = await uc.execute({});

    expect(captured?.skip).toBe(0);
    expect(captured?.take).toBe(20);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
  });

  it('maps page/pageSize to skip/take', async () => {
    let captured: ListPatientsParams | undefined;
    const repo = makeRepo({
      list: (params) => {
        captured = params;
        return Promise.resolve({ items: [], total: 0 });
      },
    });
    const uc = new ListPatientsUseCase(repo);

    const result = await uc.execute({ page: 3, pageSize: 10 });

    expect(captured?.skip).toBe(20);
    expect(captured?.take).toBe(10);
    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(10);
  });

  it('passes the query through to the repository unchanged', async () => {
    let captured: ListPatientsParams | undefined;
    const repo = makeRepo({
      list: (params) => {
        captured = params;
        return Promise.resolve({ items: [], total: 0 });
      },
    });
    const uc = new ListPatientsUseCase(repo);

    await uc.execute({ query: 'ana' });

    expect(captured?.query).toBe('ana');
  });

  it('clamps pageSize to a max of 100', async () => {
    let captured: ListPatientsParams | undefined;
    const repo = makeRepo({
      list: (params) => {
        captured = params;
        return Promise.resolve({ items: [], total: 0 });
      },
    });
    const uc = new ListPatientsUseCase(repo);

    const result = await uc.execute({ pageSize: 500 });

    expect(captured?.take).toBe(100);
    expect(result.pageSize).toBe(100);
  });

  it('clamps a non-positive page back to 1', async () => {
    let captured: ListPatientsParams | undefined;
    const repo = makeRepo({
      list: (params) => {
        captured = params;
        return Promise.resolve({ items: [], total: 0 });
      },
    });
    const uc = new ListPatientsUseCase(repo);

    const result = await uc.execute({ page: 0 });

    expect(captured?.skip).toBe(0);
    expect(result.page).toBe(1);
  });

  it('clamps a non-positive pageSize back to the default of 20', async () => {
    let captured: ListPatientsParams | undefined;
    const repo = makeRepo({
      list: (params) => {
        captured = params;
        return Promise.resolve({ items: [], total: 0 });
      },
    });
    const uc = new ListPatientsUseCase(repo);

    const result = await uc.execute({ pageSize: -5 });

    expect(captured?.take).toBe(20);
    expect(result.pageSize).toBe(20);
  });

  it('returns the items and total from the repository', async () => {
    const patients = [fakePatient('p1'), fakePatient('p2')];
    const repo = makeRepo({
      list: (): Promise<ListPatientsResult> =>
        Promise.resolve({ items: patients, total: 42 }),
    });
    const uc = new ListPatientsUseCase(repo);

    const result = await uc.execute({ page: 2, pageSize: 5 });

    expect(result.items).toBe(patients);
    expect(result.total).toBe(42);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(5);
  });
});
