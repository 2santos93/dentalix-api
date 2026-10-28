import type { ResponsibleRelationship } from '@prisma/client';
import type {
  NoticeSettings,
  NoticePatientFields,
  NoticeResponsible,
} from '../../../patients/domain/communication/notice-recipient';

export const STATEMENT_FAMILY_REPOSITORY = Symbol(
  'STATEMENT_FAMILY_REPOSITORY',
);

/** Lo que decide a nombre de quién sale el estado de cuenta (DX-203). */
export interface StatementNoticeData {
  patient: NoticePatientFields;
  responsibles: NoticeResponsible[];
  settings: NoticeSettings;
}

export interface FamilyMemberRef {
  id: string;
  firstName: string;
  lastName: string;
  /** Parentesco del pagador con este paciente; null = el propio pagador. */
  relationship: ResponsibleRelationship | null;
}

export interface StatementFamily {
  payer: FamilyMemberRef;
  /** Pacientes vivos de los que es pagador principal, por orden de alta. */
  dependents: FamilyMemberRef[];
}

// Sin tenantId: sale del contexto de la petición y todo va bajo RLS.
export interface StatementFamilyRepository {
  /** null si el paciente no existe en esta clínica (o se retiró). */
  loadNotice(patientId: string): Promise<StatementNoticeData | null>;
  /** null si el pagador no es un paciente vivo de esta clínica. */
  loadFamily(payerPatientId: string): Promise<StatementFamily | null>;
}
