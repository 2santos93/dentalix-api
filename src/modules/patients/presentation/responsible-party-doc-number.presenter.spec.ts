import { ClinicRole } from '@prisma/client';
import {
  canSeeResponsibleDocNumber,
  responsiblePartyForRole,
} from './responsible-party-doc-number.presenter';

const party = {
  id: 'r1',
  docNumber: '12345678',
  fullName: 'Luis Ortiz',
  responsiblePatient: { id: 'p1', docNumber: '87654321', firstName: 'Ana' },
};
const contact = { ...party, responsiblePatient: null };

describe('responsiblePartyForRole (SEC-044)', () => {
  it.each([ClinicRole.ADMIN, ClinicRole.RECEPTION])(
    '%s ve el documento completo',
    (role) => {
      expect(canSeeResponsibleDocNumber(role)).toBe(true);
      expect(responsiblePartyForRole(party, role)).toBe(party);
    },
  );

  it.each([ClinicRole.DENTIST, ClinicRole.ASSISTANT])(
    '%s recibe docNumber null, del contacto y del paciente responsable',
    (role) => {
      expect(canSeeResponsibleDocNumber(role)).toBe(false);
      expect(responsiblePartyForRole(party, role)).toEqual({
        ...party,
        docNumber: null,
        responsiblePatient: { ...party.responsiblePatient, docNumber: null },
      });
      expect(responsiblePartyForRole(contact, role)).toEqual({
        ...contact,
        docNumber: null,
      });
      expect(JSON.stringify(responsiblePartyForRole(party, role))).not.toMatch(
        /12345678|87654321/,
      );
    },
  );

  it('no muta la entrada', () => {
    responsiblePartyForRole(party, ClinicRole.DENTIST);
    expect(party.docNumber).toBe('12345678');
  });
});
