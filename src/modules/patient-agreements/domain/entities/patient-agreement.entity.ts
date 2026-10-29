import type { AgreementKind } from '@prisma/client';
import type { PayerType } from '../../../payers/domain/payer-type';

/** Convenio tal como viaja dentro de una asignación. */
export interface AssignedAgreement {
  id: string;
  name: string;
  kind: AgreementKind;
  active: boolean;
  /** Día civil `YYYY-MM-DD`; `null` = sin límite. */
  validFrom: string | null;
  validTo: string | null;
  payer: { id: string; name: string; type: PayerType };
}

/**
 * Convenio asignado a un paciente (DX-105). Hay una asignación viva por
 * paciente; las retiradas (`retiredAt`) son su historial. Las fechas son días
 * civiles `YYYY-MM-DD` sin zona.
 */
export interface PatientAgreement {
  id: string;
  patientId: string;
  agreement: AssignedAgreement;
  /** Cobertura del paciente que lleva su nº de afiliado (sin duplicarlo). */
  coverageId: string | null;
  validFrom: string | null;
  validTo: string | null;
  notes: string | null;
  createdAt: Date;
  /** `null` mientras está viva. */
  retiredAt: Date | null;
}
