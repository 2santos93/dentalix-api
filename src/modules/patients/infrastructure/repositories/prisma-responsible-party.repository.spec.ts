/**
 * DX-327 (fase 1, spec R4–R5): responsables con el tipo genérico y la
 * etiqueta libre. El alta de un contacto escribe la pareja con el código
 * anterior; la edición, solo las columnas nuevas.
 */
import {
  PrismaResponsiblePartyRepository,
  toView,
  type PartyRow,
} from './prisma-responsible-party.repository';

const AT = new Date('2026-10-29T00:00:00.000Z');

function partyRow(over: Partial<PartyRow> = {}): PartyRow {
  return {
    id: 'party-1',
    patientId: 'son',
    fullName: 'Luis Ortiz',
    documentType: 'PASSPORT',
    docTypeLabel: 'ID local',
    docNumber: 'RX-2001',
    email: null,
    phone: null,
    relationship: 'FATHER',
    isPayer: false,
    receivesNotices: true,
    migratedFromGuardian: false,
    createdAt: AT,
    updatedAt: AT,
    responsiblePatient: null,
    ...over,
  };
}

describe('PrismaResponsiblePartyRepository (DX-327, fase 1)', () => {
  it('a responsible party row maps the patient summary and the contact with their labels', () => {
    expect(toView(partyRow())).toMatchObject({
      kind: 'CONTACT',
      responsiblePatient: null,
      docType: 'PASSPORT',
      docTypeLabel: 'ID local',
    });
    expect(
      toView(partyRow({ documentType: null, docTypeLabel: null })),
    ).toMatchObject({ docType: null, docTypeLabel: null });

    const linked = toView(
      partyRow({
        fullName: null,
        documentType: null,
        docTypeLabel: null,
        docNumber: null,
        responsiblePatient: {
          id: 'mother',
          firstName: 'Claudia',
          lastName: 'Navarro',
          documentType: 'RESIDENCE_PERMIT',
          docTypeLabel: 'Permiso A',
          docNumber: 'RX-3001',
          email: 'claudia@example.com',
          phone: null,
        },
      }),
    );
    expect(linked).toMatchObject({
      kind: 'PATIENT',
      fullName: 'Claudia Navarro',
      docType: 'RESIDENCE_PERMIT',
      docTypeLabel: 'Permiso A',
      docNumber: 'RX-3001',
      responsiblePatient: {
        docType: 'RESIDENCE_PERMIT',
        docTypeLabel: 'Permiso A',
      },
    });
    expect(linked.responsiblePatient).not.toHaveProperty('documentType');
  });

  function fakeRepository() {
    const writes: Array<Record<string, unknown>> = [];
    const tx = {
      patientResponsibleParty: {
        create: ({ data }: { data: Record<string, unknown> }) => {
          writes.push(data);
          return Promise.resolve(partyRow());
        },
        updateMany: ({ data }: { data: Record<string, unknown> }) => {
          writes.push(data);
          return Promise.resolve({ count: 1 });
        },
        findFirstOrThrow: () => Promise.resolve(partyRow()),
      },
    };
    const prisma = {
      runWithTenant: <T>(work: (client: typeof tx) => Promise<T>) => work(tx),
    };
    const tenantContext = { getTenantId: () => 't1' };
    const repo = new PrismaResponsiblePartyRepository(
      prisma as never,
      tenantContext as never,
    );
    return { repo, writes };
  }

  it('a contact is created with the legacy pair and edited with the generic type only', async () => {
    const { repo, writes } = fakeRepository();
    const base = {
      responsiblePatientId: null,
      relationship: 'FATHER' as const,
      isPayer: false,
      receivesNotices: true,
    };
    const contact = {
      fullName: 'Luis',
      docNumber: null,
      email: null,
      phone: null,
    };
    await repo.create(
      'son',
      {
        ...base,
        contact: { ...contact, docType: 'TAX_ID', docTypeLabel: 'ID local' },
      },
      'u1',
    );
    await repo.create(
      'son',
      { ...base, contact: { ...contact, docType: null, docTypeLabel: null } },
      'u1',
    );
    await repo.create(
      'son',
      { ...base, responsiblePatientId: 'mother', contact: null },
      'u1',
    );
    expect(writes[0]).toMatchObject({
      documentType: 'TAX_ID',
      docType: 'OTHER',
      docTypeLabel: 'ID local',
    });
    expect(writes[1]).toMatchObject({
      documentType: null,
      docType: null,
      docTypeLabel: null,
    });
    expect(writes[2]).not.toHaveProperty('documentType');
    expect(writes[2]).not.toHaveProperty('docType');

    writes.length = 0;
    await repo.update('son', 'party-1', {
      contact: { docType: 'PASSPORT', docTypeLabel: null, phone: '1' },
    });
    await repo.update('son', 'party-1', { isPayer: true });
    expect(writes[0]).toMatchObject({
      documentType: 'PASSPORT',
      docTypeLabel: null,
      phone: '1',
    });
    for (const data of writes) expect(data).not.toHaveProperty('docType');
  });
});
