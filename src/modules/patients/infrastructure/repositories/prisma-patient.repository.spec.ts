/**
 * DX-327 (fase 1, spec R4–R5): el repositorio lee el tipo genérico y la
 * etiqueta libre; al crear escribe la pareja con el código anterior; al
 * cambiar, solo las columnas nuevas (el trigger ajusta la anterior).
 */
import { DOCUMENT_TYPES } from '../../domain/document-type';
import { legacyStoredDocType } from '../../domain/legacy-doc-type';
import {
  mapToEntity,
  patientDocFields,
  PrismaPatientRepository,
  type LegacyDocPair,
  type PrismaPatient,
} from './prisma-patient.repository';

const AT = new Date('2026-10-29T00:00:00.000Z');

function row(over: Partial<PrismaPatient> = {}): PrismaPatient {
  return {
    id: 'p1',
    tenantId: 't1',
    firstName: 'Ana',
    lastName: 'Gomez',
    // El código anterior de la fila no coincide a propósito con el genérico:
    // la entidad no debe leerlo.
    docType: 'OTHER',
    documentType: 'NATIONAL_ID',
    docTypeLabel: 'ID local',
    docNumber: 'RX-1001',
    birthDate: null,
    sex: 'F',
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
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
    lastAttentionAt: null,
    retentionExtended: 'NONE',
    partiallySuppressedAt: null,
    contactChannel: 'EMAIL',
    whatsappOptInAt: null,
    whatsappOptInSource: null,
    whatsappOptInById: null,
    reminderOptOutAt: null,
    reminderOptOutSource: null,
    importBatchId: null,
    ...over,
  };
}

describe('PrismaPatientRepository (DX-327, fase 1)', () => {
  it('a patient row maps documentType and docTypeLabel, never the legacy code', () => {
    const patient = mapToEntity(row());
    expect(patient.docType).toBe('NATIONAL_ID');
    expect(patient.docTypeLabel).toBe('ID local');
    expect(patient).not.toHaveProperty('documentType');

    const unlabelled = mapToEntity(
      row({ docType: 'OTHER', documentType: 'TAX_ID', docTypeLabel: null }),
    );
    expect(unlabelled).toMatchObject({ docType: 'TAX_ID', docTypeLabel: null });
  });

  it.each(DOCUMENT_TYPES)(
    'create data satisfies the legacy pair (%s)',
    (type) => {
      expect(patientDocFields(type, 'ID local')).toEqual({
        documentType: type,
        docType: legacyStoredDocType(type),
        docTypeLabel: 'ID local',
      });
      expect(patientDocFields(type, null).docTypeLabel).toBeNull();
    },
  );

  it('the legacy pair type requires the legacy code', () => {
    // @ts-expect-error R5: un alta sin el código anterior no compila (el
    // trigger tomaría el DEFAULT y un OTHER quedaría NATIONAL_ID).
    const data: LegacyDocPair = { documentType: 'OTHER' };
    expect(data.documentType).toBe('OTHER');
  });

  describe('update', () => {
    function fakeRepository() {
      const updates: Array<Record<string, unknown>> = [];
      const tx = {
        patient: {
          findFirst: () => Promise.resolve({ id: 'p1' }),
          update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
            updates.push(data);
            return Promise.resolve(row());
          }),
        },
      };
      const prisma = {
        runWithTenant: <T>(work: (client: typeof tx) => Promise<T>) => work(tx),
      };
      const tenantContext = { getTenantId: () => 't1' };
      const repo = new PrismaPatientRepository(
        prisma as never,
        tenantContext as never,
      );
      return { repo, updates, tx };
    }

    it('update writes documentType and docTypeLabel, never the legacy column', async () => {
      const { repo, updates, tx } = fakeRepository();
      await repo.update('p1', {
        firstName: 'Ana',
        docType: 'PASSPORT',
        docTypeLabel: null,
      });
      await repo.update('p1', { docTypeLabel: 'ID local' });
      await repo.update('p1', { firstName: 'Ana María' });
      expect(tx.patient.update).toHaveBeenCalledTimes(3);
      expect(updates).toEqual([
        { firstName: 'Ana', documentType: 'PASSPORT', docTypeLabel: null },
        { docTypeLabel: 'ID local' },
        { firstName: 'Ana María' },
      ]);
      for (const data of updates) expect(data).not.toHaveProperty('docType');
    });
  });
});
