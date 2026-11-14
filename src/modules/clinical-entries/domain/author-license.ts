/**
 * DX-540: registro profesional del autor de una evolución.
 *
 * Al firmar, la evolución congela el registro que el autor tiene en esta
 * clínica (`ClinicMembership.professionalLicense`); cambiarlo después no toca
 * las evoluciones ya firmadas (la BD además las hace inalterables, DX-038).
 *
 * Si la clínica activa el aviso (`Tenant.clinicalEntryLicenseWarning`, lo
 * decide el ADMIN como los ajustes de la receta de DX-324: ninguna regla
 * mira el país), firmar sin registro devuelve un aviso. Nunca bloquea.
 */

/** Códigos de aviso de la firma de una evolución (tipados en el contrato). */
export const CLINICAL_ENTRY_WARNING_CODES = [
  'PROFESSIONAL_LICENSE_MISSING',
] as const;
export type ClinicalEntryWarningCode =
  (typeof CLINICAL_ENTRY_WARNING_CODES)[number];

export interface ClinicalEntryWarning {
  code: ClinicalEntryWarningCode;
  /** Texto en español para mostrarlo tal cual. */
  message: string;
}

export const PROFESSIONAL_LICENSE_MISSING_MESSAGE =
  'La evolución se guardó sin tu número de registro profesional. Pide que lo carguen en tu ficha de Personal para que tus próximas evoluciones lo lleven.';

/** El registro tal como se congela en la evolución: recortado, o null. */
export function licenseSnapshot(
  license: string | null | undefined,
): string | null {
  const trimmed = license?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

export interface SigningLicenseInput {
  /** Ajuste de la clínica: avisar si el autor firma sin registro. */
  warnMissingProfessionalLicense: boolean;
  /** Registro del autor (el congelado al firmar, o el actual antes de firmar). */
  professionalLicense: string | null;
}

/** Avisos que acompañan a la firma; vacío si no hay nada que avisar. */
export function signingWarnings(
  input: SigningLicenseInput,
): ClinicalEntryWarning[] {
  if (!input.warnMissingProfessionalLicense) return [];
  if (licenseSnapshot(input.professionalLicense) !== null) return [];
  return [
    {
      code: 'PROFESSIONAL_LICENSE_MISSING',
      message: PROFESSIONAL_LICENSE_MISSING_MESSAGE,
    },
  ];
}
