/**
 * DX-327 (spec R4): el repositorio lee y escribe el tipo genérico y la
 * etiqueta libre; la columna anterior está congelada y nadie la toca.
 */
import { DOCUMENT_TYPES } from '../../domain/document-type';
import type { DocumentType } from '@prisma/client';
import {
  mapToEntity,
  patientDocFields,
  patientUpdateData,
  PrismaPatientRepository,
  type DocTypeColumn,
  type PrismaPatient,
} from './prisma-patient.repository';

const AT = new Date('2026-10-29T00:00:00.000Z');

function row(over: Partial<PrismaPatient> = {}): PrismaPatient {
  return {
    id: 'p1',
    tenantId: 't1',
    firstName: 'Ana',
    lastName: 'Gomez',
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
    retentionFloorUntil: null,
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

describe('PrismaPatientRepository (DX-327)', () => {
  it('a patient row maps documentType and docTypeLabel', () => {
    const patient = mapToEntity(row());
    expect(patient.docType).toBe('NATIONAL_ID');
    expect(patient.docTypeLabel).toBe('ID local');
    expect(patient).not.toHaveProperty('documentType');

    const unlabelled = mapToEntity(
      row({ documentType: 'TAX_ID', docTypeLabel: null }),
    );
    expect(unlabelled).toMatchObject({ docType: 'TAX_ID', docTypeLabel: null });
  });

  it.each(DOCUMENT_TYPES)(
    'create data writes the generic type and the label (%s)',
    (type) => {
      expect(patientDocFields(type, 'ID local')).toEqual({
        documentType: type,
        docTypeLabel: 'ID local',
      });
      expect(patientDocFields(type, null).docTypeLabel).toBeNull();
    },
  );

  it('the create column type requires the generic type', () => {
    // @ts-expect-error: un alta sin tipo no compila (la columna tomaría su
    // DEFAULT 'OTHER').
    const data: DocTypeColumn = {};
    expect(data).toEqual({});
  });

  describe('update', () => {
    /**
     * Prisma de mentira. `stored` es el tipo de la fila al bloquearla (FOR
     * UPDATE) dentro de la transacción de la escritura.
     */
    function fakeRepository(stored: DocumentType = 'NATIONAL_ID') {
      const updates: Array<Record<string, unknown>> = [];
      const locks: string[] = [];
      const tx = {
        $queryRaw: (sql: TemplateStringsArray) => {
          locks.push(sql.join('?'));
          return Promise.resolve([{ documentType: stored }]);
        },
        patient: {
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
      return { repo, updates, locks, tx };
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

    it('changing the type without a label clears the label; the same type keeps it', async () => {
      const { repo, updates, locks } = fakeRepository('NATIONAL_ID');
      await repo.update('p1', { docType: 'PASSPORT' });
      await repo.update('p1', { docType: 'NATIONAL_ID', firstName: 'Ana' });
      await repo.update('p1', { docType: 'TAX_ID', docTypeLabel: 'Fiscal A' });
      expect(updates).toEqual([
        { documentType: 'PASSPORT', docTypeLabel: null },
        { documentType: 'NATIONAL_ID', firstName: 'Ana' },
        { documentType: 'TAX_ID', docTypeLabel: 'Fiscal A' },
      ]);
      // La decisión sale de la fila bloqueada en la transacción de la escritura.
      for (const sql of locks) expect(sql).toMatch(/FOR UPDATE/);
    });

    it('the label decision uses the row type at write time, not the one read before', async () => {
      // El caso de uso leyó NATIONAL_ID; otra edición la cambió a PASSPORT
      // antes de esta escritura, que también manda PASSPORT: mismo tipo que
      // el guardado, la etiqueta (de PASSPORT) se queda.
      const changedBehind = fakeRepository('PASSPORT');
      await changedBehind.repo.update('p1', { docType: 'PASSPORT' });
      expect(changedBehind.updates).toEqual([{ documentType: 'PASSPORT' }]);
      // Y al revés: el caso de uso leyó PASSPORT, la fila ya es NATIONAL_ID:
      // la escritura de PASSPORT sí cambia el tipo y borra la etiqueta.
      const revertedBehind = fakeRepository('NATIONAL_ID');
      await revertedBehind.repo.update('p1', { docType: 'PASSPORT' });
      expect(revertedBehind.updates).toEqual([
        { documentType: 'PASSPORT', docTypeLabel: null },
      ]);
    });

    it('the update data type has no legacy column', () => {
      const data = patientUpdateData({ docType: 'OTHER' }, 'OTHER');
      // @ts-expect-error R5: un cambio nunca escribe la columna anterior.
      expect(data.docType).toBeUndefined();
    });
  });
});
