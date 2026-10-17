import type { NormalizedImplantInput } from '../implant-rules';
import type { ImplantCardLocation } from '../implant-card';
import type {
  ImplantCardPatient,
  ImplantCatalogEntry,
  ImplantLotMatch,
  PatientImplant,
} from '../entities/patient-implant.entity';

export const PATIENT_IMPLANT_REPOSITORY = Symbol('PATIENT_IMPLANT_REPOSITORY');

export interface CreatePatientImplantRepoInput extends NormalizedImplantInput {
  patientId: string;
  locationId: string;
  professionalId: string;
  placedOn: string;
  treatmentPlanItemId: string | null;
}

export type VoidImplantOutcome =
  | { kind: 'VOIDED'; implant: PatientImplant }
  | { kind: 'NOT_FOUND' }
  | { kind: 'ALREADY_VOIDED' };

export interface ImplantLotQuery {
  lot?: string;
  reference?: string;
}

/**
 * Todo corre bajo la RLS del tenant del contexto: un paciente, un implante o
 * un ítem de plan de otra clínica no existen para esta.
 */
export interface PatientImplantRepository {
  loadPatient(patientId: string): Promise<ImplantCardPatient | null>;
  /** Sede del request o la principal, con su zona IANA. */
  resolveLocation(): Promise<{ id: string; timeZone: string }>;
  /** ¿El ítem es de un plan (vivo) de ESTE paciente? */
  planItemBelongsToPatient(
    planItemId: string,
    patientId: string,
  ): Promise<boolean>;
  create(input: CreatePatientImplantRepoInput): Promise<PatientImplant>;
  listByPatient(patientId: string): Promise<PatientImplant[]>;
  listByPatientOn(
    patientId: string,
    placedOn: string,
  ): Promise<PatientImplant[]>;
  findById(id: string): Promise<PatientImplant | null>;
  void(
    id: string,
    input: { voidedById: string; voidedAt: Date; reason: string },
  ): Promise<VoidImplantOutcome>;
  /** Marca entregada la tarjeta de los implantes del día que aún no lo estén. */
  markCardDelivered(
    patientId: string,
    placedOn: string,
    input: { deliveredById: string; deliveredAt: Date },
  ): Promise<void>;
  clinicName(): Promise<string>;
  locations(ids: string[]): Promise<ImplantCardLocation[]>;
  catalog(): Promise<ImplantCatalogEntry[]>;
  searchByLot(query: ImplantLotQuery): Promise<ImplantLotMatch[]>;
}
