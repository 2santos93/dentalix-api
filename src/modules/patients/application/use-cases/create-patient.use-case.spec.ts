import { DocType, Sex } from '@prisma/client';
import { CreatePatientUseCase } from './create-patient.use-case';
import { Patient } from '../../domain/entities/patient.entity';
import {
  CreatePatientRepoInput,
  ListPatientsResult,
  PatientRepository,
} from '../../domain/ports/patient-repository.port';
import { ReferenceLookup } from '../../domain/ports/reference-lookup.port';

function fakePatientFrom(
  id: string,
  input: CreatePatientRepoInput,
  tenantId = 't1',
): Patient {
  return {
    id,
    tenantId,
    firstName: input.firstName,
    lastName: input.lastName,
    docType: input.docType,
    docNumber: input.docNumber ?? null,
    birthDate: input.birthDate ?? null,
    sex: input.sex,
    phone: input.phone ?? null,
    email: input.email ?? null,
    address: input.address ?? null,
    countryCode: input.countryCode ?? null,
    cityId: input.cityId ?? null,
    notes: input.notes ?? null,
    createdById: input.createdById ?? null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function makeRepo(
  overrides: Partial<PatientRepository> = {},
): PatientRepository {
  return {
    create: (input: CreatePatientRepoInput): Promise<Patient> =>
      Promise.resolve(fakePatientFrom('p1', input)),
    findById: (): Promise<Patient | null> => Promise.resolve(null),
    list: (): Promise<ListPatientsResult> =>
      Promise.resolve({ items: [], total: 0 }),
    update: (): Promise<Patient> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

function makeReferenceLookup(
  overrides: Partial<ReferenceLookup> = {},
): ReferenceLookup {
  return {
    cityBelongsToCountry: (): Promise<boolean> => Promise.resolve(true),
    ...overrides,
  };
}

describe('CreatePatientUseCase', () => {
  it('creates a patient and returns the mapped entity', async () => {
    const repo = makeRepo();
    const uc = new CreatePatientUseCase(repo, makeReferenceLookup());

    const result = await uc.execute({
      firstName: 'Ana',
      lastName: 'Gomez',
      docType: DocType.CC,
      sex: Sex.F,
      createdById: 'u1',
    });

    expect(result.id).toBe('p1');
    expect(result.firstName).toBe('Ana');
    expect(result.lastName).toBe('Gomez');
    expect(result.createdById).toBe('u1');
  });

  it('normalizes email (trim + lowercase) when present', async () => {
    let captured: CreatePatientRepoInput | undefined;
    const repo = makeRepo({
      create: (input) => {
        captured = input;
        return Promise.resolve(fakePatientFrom('p2', input));
      },
    });
    const uc = new CreatePatientUseCase(repo, makeReferenceLookup());

    const result = await uc.execute({
      firstName: 'Carlos',
      lastName: 'Ruiz',
      docType: DocType.CC,
      sex: Sex.M,
      email: '  Carlos.Ruiz@Example.COM  ',
    });

    expect(captured?.email).toBe('carlos.ruiz@example.com');
    expect(result.email).toBe('carlos.ruiz@example.com');
  });

  it('leaves email null when not provided (no crash on trim/lowercase of undefined)', async () => {
    const repo = makeRepo();
    const uc = new CreatePatientUseCase(repo, makeReferenceLookup());

    const result = await uc.execute({
      firstName: 'No',
      lastName: 'Email',
      docType: DocType.TI,
      sex: Sex.OTHER,
    });

    expect(result.email).toBeNull();
  });

  it('never forwards a tenantId sneaked into the input to the repository (tenant comes from context, not input)', async () => {
    let captured: (CreatePatientRepoInput & { tenantId?: string }) | undefined;
    const repo = makeRepo({
      create: (input) => {
        captured = input;
        return Promise.resolve(fakePatientFrom('p4', input));
      },
    });
    const uc = new CreatePatientUseCase(repo, makeReferenceLookup());

    // Bypass the type system deliberately to prove that even if a caller
    // stuffed a tenantId in, the use case never reads/forwards it — the
    // real guarantee (CreatePatientInput has no tenantId field) is enforced
    // at the type level for every legitimate caller.
    const maliciousInput = {
      firstName: 'X',
      lastName: 'Y',
      docType: DocType.CC,
      sex: Sex.UNSPECIFIED,
      tenantId: 'sneaky-tenant',
    } as unknown as Parameters<typeof uc.execute>[0];

    const result = await uc.execute(maliciousInput);

    expect(captured && 'tenantId' in captured).toBe(false);
    expect(result.tenantId).toBe('t1'); // comes from the repo/context, not input
  });

  it('passes createdById through to the repository', async () => {
    let captured: CreatePatientRepoInput | undefined;
    const repo = makeRepo({
      create: (input) => {
        captured = input;
        return Promise.resolve(fakePatientFrom('p3', input));
      },
    });
    const uc = new CreatePatientUseCase(repo, makeReferenceLookup());

    await uc.execute({
      firstName: 'Jane',
      lastName: 'Doe',
      docType: DocType.PASSPORT,
      sex: Sex.F,
      createdById: 'user-42',
    });

    expect(captured?.createdById).toBe('user-42');
  });
});
