/**
 * DX-540: ajustes de las evoluciones de la clínica, iguales en todas sus sedes
 * (como los de la receta, DX-324). Una clínica nueva nace con el aviso
 * desactivado.
 */
export interface ClinicalEntrySettings {
  /** Avisar al firmar una evolución si el autor no tiene registro profesional. */
  warnMissingProfessionalLicense: boolean;
}

export const PLATFORM_DEFAULT_CLINICAL_ENTRY_SETTINGS: Readonly<ClinicalEntrySettings> =
  Object.freeze({ warnMissingProfessionalLicense: false });

export const CLINICAL_ENTRY_SETTINGS_REPOSITORY = Symbol(
  'CLINICAL_ENTRY_SETTINGS_REPOSITORY',
);

export interface ClinicalEntrySettingsRepository {
  /** Los de la clínica del contexto. */
  get(): Promise<ClinicalEntrySettings>;
  /** Guarda `next` con la fila bloqueada y devuelve el antes y el después. */
  set(
    next: ClinicalEntrySettings,
  ): Promise<{ before: ClinicalEntrySettings; after: ClinicalEntrySettings }>;
}
