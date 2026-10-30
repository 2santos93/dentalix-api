import type { ResponsiblePartyOutput } from './doc-type-name.presenter';
import { responsiblePartyWithPhoneInternational } from './phone-international.presenter';

const party = (
  overrides: Partial<ResponsiblePartyOutput>,
): ResponsiblePartyOutput => ({
  id: 'r1',
  patientId: 'p1',
  kind: 'CONTACT',
  responsiblePatient: null,
  fullName: 'Rosa Pérez',
  docType: null,
  docTypeLabel: null,
  docTypeName: null,
  docNumber: null,
  email: null,
  phone: '0412-1234567',
  relationship: 'MOTHER',
  isPayer: false,
  receivesNotices: true,
  migratedFromGuardian: false,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  ...overrides,
});

describe('responsiblePartyWithPhoneInternational (DX-387)', () => {
  it('a contact gets the international format of its phone', () => {
    expect(
      responsiblePartyWithPhoneInternational(party({}), 'VE'),
    ).toMatchObject({
      phone: '0412-1234567',
      phoneInternational: '+58 412 1234567',
      responsiblePatient: null,
    });
  });

  it('a responsible patient gets it on the party and on its summary', () => {
    const out = responsiblePartyWithPhoneInternational(
      party({
        kind: 'PATIENT',
        phone: '+573105550101',
        responsiblePatient: {
          id: 'p2',
          firstName: 'Rosa',
          lastName: 'Pérez',
          docType: 'NATIONAL_ID',
          docTypeLabel: null,
          docTypeName: 'Documento nacional',
          docNumber: '1',
          email: null,
          phone: '+573105550101',
        },
      }),
      'VE',
    );
    expect(out.phoneInternational).toBe('+57 310 5550101');
    expect(out.responsiblePatient).toMatchObject({
      phone: '+573105550101',
      phoneInternational: '+57 310 5550101',
    });
  });

  it('an unreadable phone gives null and keeps the stored text', () => {
    expect(
      responsiblePartyWithPhoneInternational(party({ phone: 'oficina' }), 'VE'),
    ).toMatchObject({ phone: 'oficina', phoneInternational: null });
  });
});
