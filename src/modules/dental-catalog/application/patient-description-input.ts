import { BadRequestException } from '@nestjs/common';
import {
  patientDescriptionFromEntries,
  type PatientDescriptionEntry,
} from '../domain/patient-description';
import type { CatalogPatientLanguagesReader } from '../domain/ports/catalog-patient-languages-reader.port';

/** Sin el lector (solo en tests que no tocan la descripción): falla alto. */
export const MISSING_PATIENT_LANGUAGES_READER: CatalogPatientLanguagesReader = {
  list: () =>
    Promise.reject(
      new Error('CATALOG_PATIENT_LANGUAGES_READER no está configurado'),
    ),
};

/**
 * DX-560: valida la «Descripción para el paciente» contra los idiomas de la
 * clínica y devuelve el mapa que se guarda; `undefined` si no vino (no se
 * toca). 400 en español con el mensaje de la regla.
 */
export async function patientDescriptionInput(
  reader: CatalogPatientLanguagesReader,
  entries: readonly PatientDescriptionEntry[] | undefined,
  current: Readonly<Record<string, string>>,
): Promise<Record<string, string> | undefined> {
  if (entries === undefined) return undefined;
  const result = patientDescriptionFromEntries(entries, {
    patientLanguages: entries.length > 0 ? await reader.list() : [],
    current,
  });
  if ('error' in result) throw new BadRequestException(result.error);
  return result.map;
}
