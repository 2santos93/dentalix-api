import { ClinicRole } from '@prisma/client';

/**
 * SEC-044: el documento de un responsable es dato de cobro y contacto de un
 * tercero. Quien factura y administra (ADMIN, RECEPTION) lo ve completo; el
 * personal clínico (DENTIST, ASSISTANT) no lo necesita y recibe `null`.
 */
export function canSeeResponsibleDocNumber(role: ClinicRole): boolean {
  return role === ClinicRole.ADMIN || role === ClinicRole.RECEPTION;
}

interface WithDocNumbers {
  docNumber: string | null;
  responsiblePatient: { docNumber: string | null } | null;
}

/** El responsable tal cual para ADMIN/RECEPTION; sin documentos para el resto. */
export function responsiblePartyForRole<T extends WithDocNumbers>(
  party: T,
  role: ClinicRole,
): T {
  if (canSeeResponsibleDocNumber(role)) return party;
  return {
    ...party,
    docNumber: null,
    responsiblePatient: party.responsiblePatient
      ? { ...party.responsiblePatient, docNumber: null }
      : null,
  };
}
