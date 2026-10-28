import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DocType, Sex } from '@prisma/client';
import { UpdatePatientUseCase } from './update-patient.use-case';
import { Patient } from '../../domain/entities/patient.entity';
import {
  CreatePatientRepoInput,
  ListPatientsResult,
  PatientRepository,
  UpdatePatientRepoInput,
} from '../../domain/ports/patient-repository.port';
import { ReferenceLookup } from '../../domain/ports/reference-lookup.port';
import { FakePatientCommunicationRepository } from '../__fixtures__/fake-patient-communication.repository';

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
    partiallySuppressedAt: null,
    importBatchId: null,
    contactChannel: 'EMAIL',
    whatsappOptInAt: null,
    whatsappOptInSource: null,
    whatsappOptInById: null,
    reminderOptOutAt: null,
    reminderOptOutSource: null,
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
    const uc = new UpdatePatientUseCase(
      repo,
      makeReferenceLookup(),
      new FakePatientCommunicationRepository(),
    );

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
    const uc = new UpdatePatientUseCase(
      repo,
      makeReferenceLookup(),
      new FakePatientCommunicationRepository(),
    );

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
    const uc = new UpdatePatientUseCase(
      repo,
      makeReferenceLookup(),
      new FakePatientCommunicationRepository(),
    );

    await uc.execute(existing.id, { email: '  Ana@Example.COM  ' });

    expect(receivedPatch?.email).toBe('ana@example.com');
  });

  // DX-128: con canal WhatsApp, el móvil tiene que seguir siendo válido.
  describe('móvil de un paciente con canal WhatsApp', () => {
    function setup(patient: Patient) {
      const updates: UpdatePatientRepoInput[] = [];
      const repo = makeRepo({
        findById: (): Promise<Patient | null> => Promise.resolve(patient),
        update: (_id: string, patch: UpdatePatientRepoInput) => {
          updates.push(patch);
          return Promise.resolve({ ...patient, ...patch });
        },
      });
      const uc = new UpdatePatientUseCase(
        repo,
        makeReferenceLookup(),
        new FakePatientCommunicationRepository(),
      );
      return { uc, updates };
    }

    it.each([['123'], ['601 234 5678'], [null]])(
      'rechaza %j con 400 en español y no guarda',
      async (phone) => {
        const { uc, updates } = setup(
          fakePatient({ contactChannel: 'WHATSAPP', phone: '+573101234567' }),
        );
        const err = await uc.execute('p1', { phone }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({
          code: 'WHATSAPP_REQUIRES_VALID_MOBILE',
        });
        expect(updates).toEqual([]);
      },
    );

    it('acepta otro móvil válido (con el país de la sede)', async () => {
      const { uc, updates } = setup(
        fakePatient({ contactChannel: 'WHATSAPP', phone: '+573101234567' }),
      );
      await uc.execute('p1', { phone: '320 765 4321' });
      expect(updates).toEqual([{ phone: '320 765 4321' }]);
    });

    it('con canal EMAIL un móvil inválido se guarda (la ficha avisa)', async () => {
      const { uc, updates } = setup(fakePatient({ phone: null }));
      await uc.execute('p1', { phone: '123' });
      expect(updates).toEqual([{ phone: '123' }]);
    });
  });
});
