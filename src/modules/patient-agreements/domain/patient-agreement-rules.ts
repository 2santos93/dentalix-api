import {
  agreementStatus,
  type AgreementStatus,
} from '../../agreements/domain/agreement-rules';

/**
 * Reglas puras de la asignación del convenio al paciente (DX-105). La BD
 * repite la vigencia como CHECK y «una asignación viva por paciente» como
 * índice único parcial.
 */
export const PATIENT_AGREEMENT_NOTES_MAX = 500;

export const PATIENT_AGREEMENT_NOT_FOUND_MESSAGE =
  'El paciente no tiene convenio asignado.';
export const COVERAGE_PAYER_MISMATCH_MESSAGE =
  'La cobertura elegida no es de ese pagador.';
export const AGREEMENT_RACE_MESSAGE =
  'Otra petición acaba de cambiar el convenio del paciente; vuelve a intentarlo.';

export type PatientAgreementStatus = AgreementStatus;

/**
 * Estado de una asignación a un día civil. `INACTIVE` si el convenio está
 * desactivado o retirado; si no, se miran las dos vigencias (la del convenio Y
 * la de la asignación): `EXPIRED` si alguna terminó antes de hoy,
 * `NOT_STARTED` si alguna empieza después, `ACTIVE` el resto. Extremos
 * incluidos; sin fechas = indefinida.
 */
export function patientAgreementStatus(
  a: {
    agreement: {
      active: boolean;
      validFrom: string | null;
      validTo: string | null;
    };
    validFrom: string | null;
    validTo: string | null;
  },
  today: string,
): PatientAgreementStatus {
  const own = agreementStatus(
    { active: true, validFrom: a.validFrom, validTo: a.validTo },
    today,
  );
  const plan = agreementStatus(a.agreement, today);
  if (plan === 'INACTIVE') return 'INACTIVE';
  if (plan === 'EXPIRED' || own === 'EXPIRED') return 'EXPIRED';
  if (plan === 'NOT_STARTED' || own === 'NOT_STARTED') return 'NOT_STARTED';
  return 'ACTIVE';
}
