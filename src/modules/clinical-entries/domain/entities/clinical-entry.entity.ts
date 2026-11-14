import type { ClinicalDiagnosisKind } from '@prisma/client';
import { ClinicalEntryAddendum } from './clinical-entry-addendum.entity';

/**
 * DX-212: diagnóstico CIE-10 de la evolución, con el texto de la tabla de
 * referencia. Inalterable como la evolución; orden: el principal primero.
 */
export interface ClinicalEntryDiagnosis {
  id: string;
  icd10Code: string;
  labelEs: string;
  kind: ClinicalDiagnosisKind;
  toothFdi: string | null;
  position: number;
}

/**
 * DX-170: la cita en la que se documentó la evolución, para que la ficha diga
 * «Cita del dd/mm · Dra. X». `providerName` es null si el profesional ya no se
 * puede nombrar (no es miembro de la clínica).
 */
export interface ClinicalEntryAppointment {
  id: string;
  start: Date;
  providerId: string;
  providerName: string | null;
}

/**
 * API-facing shape of a ClinicalEntry (one clinical evolution note).
 * Deliberately NOT the raw Prisma model: repositories must `mapToEntity`
 * before returning across the port boundary (same convention as Patient /
 * MedicalHistory / DentalCatalogItem).
 *
 * This is IMMUTABLE: once created, an entry is never updated or deleted
 * (content-wise). DX-038: la BD también lo impide (trigger) y la corrección
 * es una ADENDA (`addenda`, en orden cronológico) que deja el original intacto.
 */
export interface ClinicalEntry {
  id: string;
  tenantId: string;
  patientId: string;
  entryDate: Date;
  reason: string | null;
  notes: string;
  performedById: string | null;
  /**
   * DX-540: registro profesional del autor congelado al firmar (el de su
   * membresía en esta clínica en ese momento). null si no lo tenía o en las
   * evoluciones anteriores. Cambiar el registro después no lo toca.
   */
  authorProfessionalLicense: string | null;
  /** DX-170: cita ligada (null en las evoluciones sueltas y anteriores). */
  appointmentId: string | null;
  /**
   * DX-170: plantilla con la que se redactó. Solo procedencia: el texto
   * compuesto está en `notes` y no cambia si la plantilla se edita.
   */
  templateId: string | null;
  appointment: ClinicalEntryAppointment | null;
  createdAt: Date;
  addenda: ClinicalEntryAddendum[];
  /** DX-212: vacío en las evoluciones sin diagnóstico (todas las anteriores). */
  diagnoses: ClinicalEntryDiagnosis[];
}

/**
 * DX-015-bis (D18): un recall que movió el alta de la evolución con
 * `recall`: el de la evolución (creado, con otro intervalo o reactivado) y,
 * tras él, los que la exclusión desactivó (`deactivated`, con el tipo que los
 * sustituye). La misma forma que `recallUpdates` del PATCH del ítem del plan.
 */
export interface ClinicalEntryRecallUpdate {
  recallId: string;
  recallTypeId: string;
  recallTypeName: string;
  /** Vencimiento tras el cambio (día civil). */
  dueAt: string;
  deactivated: boolean;
  replacedBy: { recallTypeId: string; recallTypeName: string } | null;
}

/** Lo que devuelve el alta: la evolución y los recalls que movió (D18). */
export interface CreatedClinicalEntryRecord extends ClinicalEntry {
  recallUpdates: ClinicalEntryRecallUpdate[];
}
