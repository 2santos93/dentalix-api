import type { ClinicalDiagnosisKind } from '@prisma/client';
import { FDI_TOOTH_NUMBER_PATTERN } from '../../odontogram/application/use-cases/add-tooth-record.use-case';
import {
  ICD10_INVALID_MESSAGE,
  isValidIcd10Format,
  normalizeIcd10Code,
} from '../../../shared/validation/health-codes';

/** Topes del RDA/RIPS (DX-212): 1 principal y hasta 3 relacionados. */
export const MAX_RELATED_DIAGNOSES = 3;

export const SECOND_PRINCIPAL_MESSAGE =
  'Solo puede haber un diagnóstico principal por evolución';
export const TOO_MANY_RELATED_MESSAGE = `Como máximo ${MAX_RELATED_DIAGNOSES} diagnósticos relacionados por evolución`;
export const RELATED_WITHOUT_PRINCIPAL_MESSAGE =
  'Los diagnósticos relacionados necesitan un diagnóstico principal';

export interface DiagnosisInput {
  icd10Code: string;
  kind: ClinicalDiagnosisKind;
  toothFdi?: string | null;
}

/**
 * Diagnóstico listo para insertar: código normalizado, diente o `null` y su
 * posición (0 = principal; 1..3 = relacionados en el orden recibido). La BD
 * repite las reglas (CHECK de la posición y único por evolución y posición).
 */
export interface ValidDiagnosis {
  icd10Code: string;
  kind: ClinicalDiagnosisKind;
  toothFdi: string | null;
  position: number;
}

export type DiagnosesResult =
  { diagnoses: ValidDiagnosis[] } | { error: string };

/**
 * Reglas de forma de los diagnósticos de una evolución. Que el código EXISTA
 * en la tabla CIE-10 lo comprueba el caso de uso contra la BD.
 */
export function validateDiagnoses(
  input: readonly DiagnosisInput[] | undefined,
): DiagnosesResult {
  if (!input || input.length === 0) return { diagnoses: [] };
  const principal = input.filter((d) => d.kind === 'PRINCIPAL');
  const related = input.filter((d) => d.kind === 'RELACIONADO');
  if (principal.length > 1) return { error: SECOND_PRINCIPAL_MESSAGE };
  if (related.length > MAX_RELATED_DIAGNOSES) {
    return { error: TOO_MANY_RELATED_MESSAGE };
  }
  if (principal.length === 0) {
    return { error: RELATED_WITHOUT_PRINCIPAL_MESSAGE };
  }

  const ordered = [...principal, ...related];
  const seen = new Set<string>();
  const diagnoses: ValidDiagnosis[] = [];
  for (const [position, d] of ordered.entries()) {
    const icd10Code = normalizeIcd10Code(d.icd10Code);
    if (!isValidIcd10Format(icd10Code)) {
      return { error: `${ICD10_INVALID_MESSAGE}: «${icd10Code}»` };
    }
    const tooth = d.toothFdi?.trim() || null;
    if (tooth !== null && !FDI_TOOTH_NUMBER_PATTERN.test(tooth)) {
      return { error: `El diente «${tooth}» no es un número FDI válido` };
    }
    const key = `${icd10Code}|${tooth ?? ''}`;
    if (seen.has(key)) {
      return { error: `El diagnóstico ${icd10Code} está repetido` };
    }
    seen.add(key);
    diagnoses.push({ icd10Code, kind: d.kind, toothFdi: tooth, position });
  }
  return { diagnoses };
}
