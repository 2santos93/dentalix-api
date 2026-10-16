import { createHash } from 'node:crypto';
import type { ClinicCountry } from '@prisma/client';
import type { AllergyMatch } from './allergy-match';

export interface PrescriptionItemContent {
  position: number;
  activeIngredient: string;
  brandName: string | null;
  concentration: string;
  pharmaceuticalForm: string;
  route: string;
  dose: string;
  frequency: string;
  durationDays: number;
  totalQuantity: number;
  quantityUnit: string;
  quantityInWords: string;
  packages: number | null;
  instructions: string | null;
}

/** Todo lo que la receta EMITIDA afirma; el hash lo sella. */
export interface PrescriptionHashInput {
  country: ClinicCountry;
  issuedAt: Date;
  dispensationDate: string;
  validUntil: string;
  patientId: string;
  patientName: string;
  patientDocument: string | null;
  patientBirthYear: number | null;
  clinicalRecordNumber: string | null;
  professionalId: string;
  professionalName: string;
  professionalLicense: string;
  professionalEmail: string | null;
  clinicName: string;
  locationName: string;
  locationAddress: string | null;
  notes: string | null;
  allergyOverride: boolean;
  allergyMatches: AllergyMatch[];
  items: PrescriptionItemContent[];
}

/**
 * SHA-256 (hex) del contenido emitido. Mismo criterio que el consentimiento
 * (consent-hash.ts): ARRAY JSON con orden fijo y versión al principio, así que
 * las fronteras entre campos no se pueden correr y el formato puede cambiar
 * sin invalidar los hashes guardados. La anulación (estado, quién, cuándo,
 * motivo) NO entra: anular no altera lo que se prescribió.
 */
export function computePrescriptionHash(input: PrescriptionHashInput): string {
  const canonical = JSON.stringify([
    'dentalix-prescription-v1',
    input.country,
    input.issuedAt.toISOString(),
    input.dispensationDate,
    input.validUntil,
    input.patientId,
    input.patientName,
    input.patientDocument,
    input.patientBirthYear,
    input.clinicalRecordNumber,
    input.professionalId,
    input.professionalName,
    input.professionalLicense,
    input.professionalEmail,
    input.clinicName,
    input.locationName,
    input.locationAddress,
    input.notes,
    input.allergyOverride,
    input.allergyMatches.map((m) => [m.activeIngredient, m.allergen]),
    input.items.map((i) => [
      i.position,
      i.activeIngredient,
      i.brandName,
      i.concentration,
      i.pharmaceuticalForm,
      i.route,
      i.dose,
      i.frequency,
      i.durationDays,
      i.totalQuantity,
      i.quantityUnit,
      i.quantityInWords,
      i.packages,
      i.instructions,
    ]),
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
