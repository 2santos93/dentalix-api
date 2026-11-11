import type { ResponsibleRelationship } from '@prisma/client';
import type { NoticeSettings } from '../communication/notice-recipient';
import type { MajorityReviewDecision } from '../responsible-parties/majority-review';

export const MAJORITY_REVIEW_REPOSITORY = Symbol('MAJORITY_REVIEW_REPOSITORY');

/** Un responsable VIVO tal como lo ve la revisión (DX-342). */
export interface MajorityReviewResponsible {
  id: string;
  name: string;
  relationship: ResponsibleRelationship;
  receivesNotices: boolean;
  isPayer: boolean;
  createdAt: Date;
}

/** La última revisión guardada, con quién la hizo. */
export interface StoredMajorityReview {
  decision: MajorityReviewDecision;
  /** YYYY-MM-DD. */
  majorityDate: string;
  reviewedAt: Date;
  reviewedById: string;
  /** Nombre del usuario; null si ya no es de la clínica. */
  reviewedByName: string | null;
}

export interface MajorityReviewSnapshot {
  patient: { id: string; birthDate: Date | null };
  /** Vivos y en orden de alta (los mismos que la regla de destinatario). */
  responsibles: MajorityReviewResponsible[];
  review: StoredMajorityReview | null;
  /** Zona de la sede activa o principal y mayoría de edad de la clínica. */
  settings: NoticeSettings;
}

export interface NewMajorityReview {
  patientId: string;
  decision: MajorityReviewDecision;
  note: string | null;
  /** YYYY-MM-DD. */
  majorityDate: string;
  reviewedById: string;
}

/** Fila candidata de la lista «Pasan a la mayoría de edad». */
export interface ComingOfAgeCandidate {
  patientId: string;
  firstName: string;
  lastName: string;
  patientCode: number;
  birthDate: Date;
  responsiblesCount: number;
  /** Alta del responsable vivo más antiguo. */
  firstResponsibleAt: Date;
  review: { decision: MajorityReviewDecision; majorityDate: string } | null;
  /** Sede del paciente: la de su última cita atendida (null sin ninguna). */
  locationId: string | null;
  locationName: string | null;
}

export interface ComingOfAgeQuery {
  /** Nacidos hasta este día (inclusive): su mayoría cae como tarde en `to`. */
  maxBirthDate: string;
  /** Nacidos desde este día: su mayoría puede caer en el período. */
  minBirthDate: string;
  majorityAge: number;
  /** Sedes permitidas al miembro; `undefined` = todas. */
  locationIds?: readonly string[];
}

export interface MajorityReviewRepository {
  /** null si el paciente no es de la clínica o está archivado. */
  load(patientId: string): Promise<MajorityReviewSnapshot | null>;
  insert(review: NewMajorityReview): Promise<void>;
  /** Zona de la sede activa o principal y mayoría de edad de la clínica. */
  settings(): Promise<NoticeSettings>;
  /** ¿Es una sede de la clínica (aunque esté retirada)? */
  locationExists(locationId: string): Promise<boolean>;
  /**
   * Pacientes vivos con al menos un responsable vivo nacidos en
   * [minBirthDate, maxBirthDate], más los nacidos antes cuyo primer
   * responsable pudo darse de alta antes de su mayoría de edad (candidatos a
   * pendientes atrasados). El caso de uso decide con la regla exacta.
   */
  comingOfAge(query: ComingOfAgeQuery): Promise<ComingOfAgeCandidate[]>;
}
