/**
 * DX-560: los idiomas de los pacientes de la clínica (`tenants.patientLanguages`),
 * contra los que se valida la «Descripción para el paciente».
 */
export interface CatalogPatientLanguagesReader {
  list(): Promise<string[]>;
}

export const CATALOG_PATIENT_LANGUAGES_READER = Symbol(
  'CATALOG_PATIENT_LANGUAGES_READER',
);
