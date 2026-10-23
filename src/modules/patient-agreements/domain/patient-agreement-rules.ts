import type { PayerType } from '@prisma/client';
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
export const COVERAGE_NOT_LIVE_MESSAGE =
  'La cobertura elegida no está vigente hoy: revisa sus fechas o elige otra.';
export const INTERNAL_AGREEMENT_ADMIN_ONLY_MESSAGE =
  'Este convenio no es de un pagador externo (cortesía, empleados…): solo un administrador puede asignarlo.';

/** 400 de un convenio de pagador sin cobertura elegida (SEC-047). */
export function coverageRequiredMessage(payerName: string): string {
  return `Este convenio es de «${payerName}»: elige una cobertura vigente del paciente con ese pagador. Si no la tiene, añádela antes en la ficha.`;
}

/**
 * SEC-047: ¿el convenio es de un pagador externo real? Todo convenio tiene
 * pagador (`agreements.payerId` es NOT NULL); el tipo `OTRO` («Otro / sin
 * clasificar») es el que se usa para los convenios internos —cortesía,
 * empleados, socios—, que nadie de fuera respalda. Con uno externo, la
 * asignación exige una cobertura viva del paciente con ese pagador; uno
 * interno solo lo asigna ADMIN.
 */
export function isExternalPayer(type: PayerType): boolean {
  return type !== 'OTRO';
}

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
