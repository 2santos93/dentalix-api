import { ClinicRole } from '@prisma/client';
import { isExternalPayer } from '../../payers/domain/payer-type';
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
  'Este convenio no es de un pagador externo (cortesía, empleados…): solo un administrador puede asignarlo. Si es una aseguradora, pide al administrador que reclasifique el pagador.';

/** 400 de un convenio de pagador sin cobertura elegida (SEC-047). */
export function coverageRequiredMessage(payerName: string): string {
  return `Este convenio es de «${payerName}»: elige una cobertura vigente del paciente con ese pagador. Si no la tiene, añádela antes en la ficha.`;
}

/**
 * SEC-047: con un pagador externo (`isExternalPayer`, en el catálogo de
 * pagadores), la asignación exige una cobertura viva del paciente con ese
 * pagador; un convenio interno (pagador OTHER) solo lo asigna ADMIN, salvo que
 * el paciente traiga una cobertura MIGRADA del texto libre de aseguradora
 * anterior a DX-153 de ese pagador: el relleno creó pagadores OTHER para aseguradoras reales sin
 * clasificar, y esa cobertura sale de la ficha original (la API no la puede
 * crear), así que habilita a cualquier rol.
 */
export { isExternalPayer };

/** 403 de SEC-049: qué falta para que un rol no ADMIN use esa cobertura. */
export const COVERAGE_SELF_DECLARED_MESSAGE =
  'Registraste tú el pagador o el nº de afiliado de esta cobertura y aún no la ha verificado un administrador: pide a un administrador que la verifique (o que asigne él el convenio).';

/** Lo que mira `coverageTrustedFor` de la cobertura elegida. */
export interface CoverageTrustFacts {
  verifiedAt: Date | null;
  /** Quién puso por última vez su pagador o su nº de afiliado. */
  declaredById: string | null;
  migratedFromInsurerEps: boolean;
}

/**
 * SEC-049: ¿puede este usuario asignar un convenio con esa cobertura? Sin
 * esto, quien no es ADMIN creaba la cobertura y se asignaba el convenio del
 * 100 % en la llamada siguiente. Vale si:
 * - asigna un ADMIN (como hasta ahora);
 * - un ADMIN la verificó (y nadie cambió después su pagador o su número:
 *   cambiarlos borra la verificación);
 * - es migrada del texto libre de aseguradora anterior a DX-153 (sale de la
 *   ficha original, no de la API);
 * - o su pagador y su número los registró OTRO usuario. Sin autor conocido
 *   (filas anteriores a la API) cuenta como de otro.
 */
export function coverageTrustedFor(
  coverage: CoverageTrustFacts,
  actor: { userId: string; role: ClinicRole },
): boolean {
  if (actor.role === ClinicRole.ADMIN) return true;
  if (coverage.verifiedAt !== null || coverage.migratedFromInsurerEps) {
    return true;
  }
  return coverage.declaredById !== actor.userId;
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
