/**
 * Excepción G5.3 (DX-334): recetas emitidas antes de DX-324. Los formatos v1 y
 * v2 sellan el país de la plantilla legada; la v3 (receta única) no lo lleva.
 */
import { createHash } from 'node:crypto';
import type { AllergyMatch } from './allergy-match';
import type { LegacyPrescriptionCountry } from './legacy-prescription';
import type { SafetyAlert } from './prescription-safety';

// El redondeo del peso vive en la foto del paciente, sin país; se reexporta
// aquí porque es la regla con la que se sella (spec §3.3).
export { roundWeightKg } from './patient-snapshot';

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

/** Lo que toda receta EMITIDA afirma, legada o única; el hash lo sella. */
interface PrescriptionHashContent {
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
  /**
   * DX-324: foto de la receta única. Solo la lee la v3, con `?? null`. El
   * peso llega ya redondeado (`roundWeightKg` de `patient-snapshot.ts`).
   */
  professionalSpecialty?: string | null;
  patientAgeYears?: number | null;
  patientWeightKg?: number | null;
}

/**
 * Receta legada (v1/v2): `singleFormat` ausente o `false`, y SIEMPRE con el
 * país de su plantilla, primer campo del hash. Los campos de la receta única
 * pueden venir (la fila los tiene, a `null`) y se ignoran, así las llamadas
 * v1/v2 compilan sin tocarlas y sus hashes no cambian ni un byte (pre-flight
 * I2).
 */
export interface LegacyPrescriptionHashInput extends PrescriptionHashContent {
  country: LegacyPrescriptionCountry;
  singleFormat?: false;
  printQuantityInWords?: boolean | null;
}

/**
 * Receta única (v3, spec §3.3): con sus avisos de seguridad y el ajuste de
 * las letras como booleano. No sella el país: si la fila de fase 1 lo trae
 * (lo copia el repositorio), se ignora.
 */
export interface SingleFormatPrescriptionHashInput extends PrescriptionHashContent {
  singleFormat: true;
  printQuantityInWords: boolean;
  safetyAlerts: SafetyAlert[];
  country?: LegacyPrescriptionCountry;
}

export type PrescriptionHashInput =
  LegacyPrescriptionHashInput | SingleFormatPrescriptionHashInput;

/**
 * SHA-256 (hex) del contenido emitido. Mismo criterio que el consentimiento
 * (consent-hash.ts): ARRAY JSON con orden fijo y versión al principio, así que
 * las fronteras entre campos no se pueden correr y el formato puede cambiar
 * sin invalidar los hashes guardados (DX-300 añadió la v2). La anulación (estado, quién, cuándo,
 * motivo) NO entra: anular no altera lo que se prescribió.
 */
export function computePrescriptionHash(input: PrescriptionHashInput): string {
  const canonical = JSON.stringify(
    input.singleFormat === true
      ? singleFormatFields(input)
      : legacyFields(input),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Una receta tal como se guarda y se lee (fila o entidad): el formato aún
 * sin estrechar y las columnas que la v3 exige, nulables.
 */
export type StoredPrescriptionHashInput = PrescriptionHashContent & {
  country: LegacyPrescriptionCountry | null;
  singleFormat: boolean;
  printQuantityInWords: boolean | null;
};

/**
 * El hash que DEBERÍA tener una receta guardada, sellada con el formato que
 * dice su foto (spec R10), o `null` si la fila no se puede sellar con él:
 * única sin avisos o sin el booleano de las letras, o legada sin país. Los
 * CHECK y el NOT NULL de la tabla lo impiden; si aun así ocurre, quien lee
 * responde `integrityOk: false`, nunca un 500.
 */
export function expectedPrescriptionHash(
  rx: StoredPrescriptionHashInput,
): string | null {
  const { country, ...content } = rx;
  const { printQuantityInWords, safetyAlerts } = content;
  if (content.singleFormat) {
    if (printQuantityInWords === null || safetyAlerts === null) return null;
    return computePrescriptionHash({
      ...content,
      singleFormat: true,
      printQuantityInWords,
      safetyAlerts,
    });
  }
  if (country === null) return null;
  return computePrescriptionHash({ ...content, country, singleFormat: false });
}

/** v1 o v2, exactamente como antes de DX-324: con país y sin campos nuevos. */
function legacyFields(input: LegacyPrescriptionHashInput): unknown[] {
  // Segunda guarda, por si una entrada llega sin tipar (JSON, casts).
  if (input.country === undefined) {
    throw new Error('Una receta legada se sella siempre con su país');
  }
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
  return input.safetyAlerts === null
    ? ['dentalix-prescription-v1', ...fields]
    : [
        'dentalix-prescription-v2',
        ...fields,
        input.safetyRulesVersion,
        safetyAlertFields(input.safetyAlerts),
        input.safetyOverrideReason,
      ];
}

function safetyAlertFields(alerts: SafetyAlert[]): unknown[] {
  return alerts.map((a) => [
    a.rule,
    a.code,
    a.severity,
    a.activeIngredient,
    a.message,
    a.source,
  ]);
}

/**
 * v3 (DX-324, spec §3.3): la receta única. Sin país, y las letras solo si la
 * foto dice que se imprimen, así que dejar de escribirlas (fase 2) no cambia
 * ningún hash v3. Siempre lleva avisos de seguridad (aunque sea `[]`).
 */
function singleFormatFields(
  input: SingleFormatPrescriptionHashInput,
): unknown[] {
  if (input.safetyAlerts === null) {
    throw new Error(
      'Una receta única se sella siempre con sus avisos de seguridad',
    );
  }
  // Nunca `null` por omisión: la fila guarda un booleano, y un hash sellado con
  // `null` no volvería a validar al leerla.
  const { printQuantityInWords } = input;
  if (typeof printQuantityInWords !== 'boolean') {
    throw new Error(
      'Una receta única se sella siempre con printQuantityInWords (true o false)',
    );
  }
  return [
    'dentalix-prescription-v3',
    input.issuedAt.toISOString(),
    input.dispensationDate,
    input.validUntil,
    input.patientId,
    input.patientName,
    input.patientDocument,
    input.patientBirthYear,
    input.patientAgeYears ?? null,
    input.patientWeightKg ?? null,
    input.clinicalRecordNumber,
    input.professionalId,
    input.professionalName,
    input.professionalLicense,
    input.professionalSpecialty ?? null,
    input.professionalEmail,
    input.clinicName,
    input.locationName,
    input.locationAddress,
    input.notes,
    input.allergyOverride,
    printQuantityInWords,
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
      printQuantityInWords ? i.quantityInWords : null,
      i.packages,
      i.instructions,
    ]),
    input.safetyRulesVersion,
    safetyAlertFields(input.safetyAlerts),
    input.safetyOverrideReason,
  ];
}
