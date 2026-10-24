import { createHash } from 'node:crypto';
import type { ClinicCountry } from '@prisma/client';
import type { AllergyMatch } from './allergy-match';
import type { SafetyAlert } from './prescription-safety';

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
  /**
   * DX-300. `null` en las tres = receta emitida antes de la receta segura:
   * se sella con el formato v1 de siempre, así su hash sigue validando. Una
   * receta nueva lleva siempre la versión y la lista (aunque esté vacía).
   */
  safetyRulesVersion: string | null;
  safetyAlerts: SafetyAlert[] | null;
  safetyOverrideReason: string | null;
  items: PrescriptionItemContent[];
}

/**
 * SHA-256 (hex) del contenido emitido. Mismo criterio que el consentimiento
 * (consent-hash.ts): ARRAY JSON con orden fijo y versión al principio, así que
 * las fronteras entre campos no se pueden correr y el formato puede cambiar
 * sin invalidar los hashes guardados (DX-300 añadió la v2). La anulación (estado, quién, cuándo,
 * motivo) NO entra: anular no altera lo que se prescribió.
 */
export function computePrescriptionHash(input: PrescriptionHashInput): string {
  const fields = [
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
  ];
  // v1 (DX-013) intacto para las recetas emitidas antes de DX-300; v2 añade
  // al final versión de reglas, avisos y motivo de la confirmación.
  const canonical = JSON.stringify(
    input.safetyAlerts === null
      ? ['dentalix-prescription-v1', ...fields]
      : [
          'dentalix-prescription-v2',
          ...fields,
          input.safetyRulesVersion,
          input.safetyAlerts.map((a) => [
            a.rule,
            a.code,
            a.severity,
            a.activeIngredient,
            a.message,
            a.source,
          ]),
          input.safetyOverrideReason,
        ],
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
