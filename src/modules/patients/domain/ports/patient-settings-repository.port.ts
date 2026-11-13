export const PATIENT_SETTINGS_REPOSITORY = Symbol(
  'PATIENT_SETTINGS_REPOSITORY',
);

/** Ajustes de pacientes de la clínica del contexto (DX-328). */
export interface PatientSettingsRepository {
  /** `tenants.majorityAge` de la clínica del contexto. */
  getMajorityAge(): Promise<number>;
  /**
   * Cambia la mayoría de edad y devuelve la de antes y la de después, leídas
   * y escritas en la MISMA transacción con la fila de la clínica bloqueada:
   * dos ADMIN a la vez no dejan un «antes» que no fue real.
   */
  setMajorityAge(age: number): Promise<{ before: number; after: number }>;
  /** DX-497: `tenants.patientLanguages` de la clínica del contexto. */
  getPatientLanguages(): Promise<string[]>;
  /**
   * DX-497: cambia la lista (ya normalizada) y devuelve la de antes y la de
   * después, con la fila de la clínica bloqueada (como la mayoría de edad).
   * No toca a ningún paciente: el que tenía un idioma retirado lo conserva.
   */
  setPatientLanguages(
    languages: string[],
  ): Promise<{ before: string[]; after: string[] }>;
}
