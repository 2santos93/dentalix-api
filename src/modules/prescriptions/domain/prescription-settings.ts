/**
 * Ajustes de receta de la clínica (DX-324, spec R3): iguales en todas sus
 * sedes. Una clínica nueva nace con los valores de plataforma.
 */
export interface PrescriptionSettings {
  /** La receta imprime la cantidad total también en letras. */
  printQuantityInWords: boolean;
  /** Exige el documento del paciente y lo imprime como nº de historia clínica. */
  requireClinicalRecordNumber: boolean;
  /** Días civiles de validez, contando el de la dispensación. */
  validityDays: number;
  /**
   * DX-468: pie de la copia de la receta para el paciente; `null` = el de
   * plataforma («Copia para el paciente…»). No forma parte de la receta
   * emitida (ni del hash): se lee al abrir la copia.
   */
  patientCopyFooter: string | null;
}

export const PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS: Readonly<PrescriptionSettings> =
  Object.freeze({
    printQuantityInWords: false,
    requireClinicalRecordNumber: false,
    validityDays: 30,
    patientCopyFooter: null,
  });

export const PRESCRIPTION_VALIDITY_DAYS_MIN = 1;
export const PRESCRIPTION_VALIDITY_DAYS_MAX = 365;
export const PRESCRIPTION_VALIDITY_DAYS_MESSAGE =
  'La validez de la receta tiene que ser un número entero de días entre 1 y 365.';

export function isValidPrescriptionValidityDays(
  value: unknown,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PRESCRIPTION_VALIDITY_DAYS_MIN &&
    value <= PRESCRIPTION_VALIDITY_DAYS_MAX
  );
}

export const PRESCRIPTION_COPY_FOOTER_MESSAGE =
  'El pie de la copia para el paciente tiene que tener entre 1 y 300 caracteres (o déjalo vacío para usar el de plataforma).';

/**
 * El pie tal como se guarda: recortado; vacío = `null` (el de plataforma).
 * `undefined` si no cabe (1..300 tras recortar).
 */
export function normalizePatientCopyFooter(
  value: string | null | undefined,
): string | null | undefined {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (text === '') return null;
  return text.length <= 300 ? text : undefined;
}

/** Código de auditoría: RX_W{0|1}_H{0|1}_V{días}, p. ej. RX_W1_H0_V30. */
export function prescriptionSettingsCode(s: PrescriptionSettings): string {
  const flag = (on: boolean) => (on ? 1 : 0);
  return `RX_W${flag(s.printQuantityInWords)}_H${flag(s.requireClinicalRecordNumber)}_V${s.validityDays}`;
}
