import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ClinicRole, DocType, Sex } from '@prisma/client';
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
    // El resumen deprecado lo deriva el repositorio de la fila de consentimiento.
    dataConsentAccepted: false,
    dataConsentAt: null,
    dataConsentPolicyVersion: null,
    maritalStatus: input.maritalStatus ?? null,
    occupation: input.occupation ?? null,
    insurerEps: input.insurerEps ?? null,
    physicianName: input.physicianName ?? null,
    physicianPhone: input.physicianPhone ?? null,
    emergencyContactName: input.emergencyContactName ?? null,
    emergencyContactRelationship: input.emergencyContactRelationship ?? null,
    emergencyContactPhone: input.emergencyContactPhone ?? null,
    guardianName: input.guardianName ?? null,
    guardianDocNumber: input.guardianDocNumber ?? null,
    createdById: input.createdById ?? null,
    lastAttentionAt: null,
    retentionExtended: 'NONE',
    retentionUntil: null,
    underRetention: false,
    partiallySuppressedAt: null,
    contactChannel: 'EMAIL',
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
      Promise.resolve(fakePatientFrom('p1', input)),
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
      actorRole: ClinicRole.ADMIN,
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
      actorRole: ClinicRole.ADMIN,
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
      actorRole: ClinicRole.ADMIN,
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
      actorRole: ClinicRole.ADMIN,
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
      actorRole: ClinicRole.ADMIN,
      firstName: 'Jane',
      lastName: 'Doe',
      docType: DocType.PASSPORT,
      sex: Sex.F,
      createdById: 'user-42',
    });

    expect(captured?.createdById).toBe('user-42');
  });

  it('deriva las banderas y pasa la historia v1 al repo cuando viene medicalHistory', async () => {
    let captured: CreatePatientRepoInput | undefined;
    const repo = makeRepo({
      create: (input) => {
        captured = input;
        return Promise.resolve(fakePatientFrom('p1', input));
      },
    });
    const uc = new CreatePatientUseCase(repo, makeReferenceLookup());

    await uc.execute({
      actorRole: ClinicRole.ADMIN,
      firstName: 'Ana',
      lastName: 'Ríos',
      docType: DocType.CC,
      sex: Sex.F,
      medicalHistory: {
        allergies: [
          {
            alergeno: 'Penicilina',
            tipo: 'MEDICAMENTO',
            severidad: 'MODERADA',
            esAlerta: true,
          },
        ],
      },
    });

    expect(captured?.medicalHistory).toBeDefined();
    expect(captured?.medicalHistory?.hasCriticalAlert).toBe(true);
    expect(captured?.medicalHistory?.safetyFlags.alergiaPenicilina).toBe(true);
  });

  it('no adjunta historia cuando no viene medicalHistory', async () => {
    let captured: CreatePatientRepoInput | undefined;
    const repo = makeRepo({
      create: (input) => {
        captured = input;
        return Promise.resolve(fakePatientFrom('p1', input));
      },
    });
    const uc = new CreatePatientUseCase(repo, makeReferenceLookup());
    await uc.execute({
      actorRole: ClinicRole.ADMIN,
      firstName: 'Ana',
      lastName: 'Ríos',
      docType: DocType.CC,
      sex: Sex.F,
    });
    expect(captured).toBeDefined();
    expect(captured?.medicalHistory).toBeUndefined();
  });

  // SEC-005: la matriz de roles niega la historia clínica a recepción
  // (CLINICAL_ROLES). POST /patients no puede ser la puerta trasera para
  // escribir la anamnesis v1: se rechaza con 403 explícito, no se ignora.
  describe('anamnesis inicial según el rol (SEC-005)', () => {
    const demographics = {
      firstName: 'Ana',
      lastName: 'Ríos',
      docType: DocType.CC,
      sex: Sex.F,
    };
    const withHistory = {
      ...demographics,
      medicalHistory: {
        medications: [{ nombre: 'Warfarina', esAlerta: true }],
      },
    };

    it('RECEPTION con medicalHistory -> 403 y no crea nada', async () => {
      const create = jest.fn();
      const uc = new CreatePatientUseCase(
        makeRepo({ create }),
        makeReferenceLookup(),
      );
      await expect(
        uc.execute({ ...withHistory, actorRole: ClinicRole.RECEPTION }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(create).not.toHaveBeenCalled();
    });

    it('RECEPTION sin medicalHistory crea el paciente', async () => {
      const uc = new CreatePatientUseCase(makeRepo(), makeReferenceLookup());
      await expect(
        uc.execute({ ...demographics, actorRole: ClinicRole.RECEPTION }),
      ).resolves.toMatchObject({ firstName: 'Ana' });
    });

    it.each([ClinicRole.DENTIST, ClinicRole.ASSISTANT, ClinicRole.ADMIN])(
      '%s sigue creando la v1',
      async (role) => {
        let captured: CreatePatientRepoInput | undefined;
        const uc = new CreatePatientUseCase(
          makeRepo({
            create: (input) => {
              captured = input;
              return Promise.resolve(fakePatientFrom('p1', input));
            },
          }),
          makeReferenceLookup(),
        );
        await uc.execute({ ...withHistory, actorRole: role });
        expect(captured?.medicalHistory?.data).toEqual({
          medications: [{ nombre: 'Warfarina', esAlerta: true }],
        });
      },
    );
  });

  describe('autorización de datos en el alta (DX-037)', () => {
    function capturing(): {
      uc: CreatePatientUseCase;
      captured: () => CreatePatientRepoInput | undefined;
    } {
      let captured: CreatePatientRepoInput | undefined;
      const repo = makeRepo({
        create: (input) => {
          captured = input;
          return Promise.resolve(fakePatientFrom('p9', input));
        },
      });
      return {
        uc: new CreatePatientUseCase(repo, makeReferenceLookup()),
        captured: () => captured,
      };
    }
    const base = {
      firstName: 'Ana',
      lastName: 'Gomez',
      docType: DocType.CC,
      sex: Sex.F,
      createdById: 'u1',
      actorRole: ClinicRole.RECEPTION,
    };

    it('sin dataConsents ni booleano no registra ninguna autorización', async () => {
      const { uc, captured } = capturing();
      await uc.execute(base);
      expect(captured()?.consent).toBeUndefined();
    });

    it('pasa las decisiones explícitas con quién y la evidencia de la petición', async () => {
      const { uc, captured } = capturing();
      await uc.execute({
        ...base,
        dataConsents: {
          policyVersionId: 'pol-1',
          decisions: [{ scope: 'GENERAL', granted: true }],
        },
        consentEvidence: { ipAddress: '10.0.0.1', userAgent: 'jest' },
      });
      expect(captured()?.consent).toEqual({
        kind: 'versioned',
        policyVersionId: 'pol-1',
        decisions: [{ scope: 'GENERAL', granted: true }],
        recordedById: 'u1',
        evidence: { ipAddress: '10.0.0.1', userAgent: 'jest' },
      });
    });

    it('rechaza dataConsents sin decisiones (400) antes de crear nada', async () => {
      const { uc, captured } = capturing();
      await expect(
        uc.execute({
          ...base,
          dataConsents: { policyVersionId: 'pol-1', decisions: [] },
        }),
      ).rejects.toThrow(BadRequestException);
      expect(captured()).toBeUndefined();
    });

    it('el booleano deprecado se traduce a una fila LEGACY', async () => {
      const { uc, captured } = capturing();
      await uc.execute({
        ...base,
        dataConsentAccepted: true,
        dataConsentPolicyVersion: 'v1',
      });
      expect(captured()?.consent).toEqual({
        kind: 'legacy',
        granted: true,
        legacyPolicyVersion: 'v1',
        recordedById: 'u1',
        evidence: {},
      });
    });

    it('dataConsents gana sobre el booleano deprecado', async () => {
      const { uc, captured } = capturing();
      await uc.execute({
        ...base,
        dataConsentAccepted: true,
        dataConsents: {
          policyVersionId: 'pol-1',
          decisions: [{ scope: 'MARKETING', granted: true }],
        },
      });
      expect(captured()?.consent?.kind).toBe('versioned');
    });
  });
});
