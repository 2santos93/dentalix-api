import { ClinicRole } from '@prisma/client';
import { RECALL_LIST_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { RECALL_LIST_FORBIDDEN_MESSAGE as CONTROLLER_MESSAGE } from '../presentation/recall.controller';
import {
  RECALL_LIST_FORBIDDEN_MESSAGE,
  canRecordRecallContacts,
} from './recall-access';

// Revisión de seguridad de DX-465: `recallContact` en POST /appointments no
// abre los contactos de recall a roles que no los registran.
describe('canRecordRecallContacts', () => {
  it('solo los roles de la lista de recall (ADMIN y RECEPTION)', () => {
    expect(
      Object.values(ClinicRole).filter((r) => canRecordRecallContacts(r)),
    ).toEqual(
      Object.values(ClinicRole).filter((r) => RECALL_LIST_ROLES.includes(r)),
    );
    expect(canRecordRecallContacts(ClinicRole.ADMIN)).toBe(true);
    expect(canRecordRecallContacts(ClinicRole.RECEPTION)).toBe(true);
    expect(canRecordRecallContacts(ClinicRole.DENTIST)).toBe(false);
    expect(canRecordRecallContacts(ClinicRole.ASSISTANT)).toBe(false);
    expect(canRecordRecallContacts(null)).toBe(false);
  });

  it('el 403 es el mismo que el de /recall', () => {
    expect(CONTROLLER_MESSAGE).toBe(RECALL_LIST_FORBIDDEN_MESSAGE);
  });
});
