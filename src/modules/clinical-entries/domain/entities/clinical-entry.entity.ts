import { ClinicalEntryAddendum } from './clinical-entry-addendum.entity';

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
}
