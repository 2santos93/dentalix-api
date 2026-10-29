import type { DocType } from '@prisma/client';
import type { ImportPatientData } from './import-fields';
import { docKey, type RowIssue } from './row-validation';

export interface CandidateRow {
  rowNumber: number;
  data: ImportPatientData;
}

/** Paciente vivo de la clínica con el mismo documento (clave `docKey`). */
export interface ExistingPatientDoc {
  id: string;
  docType: DocType;
  docKey: string;
  /** Pidió la supresión parcial de sus datos (Ley 1581): no se rellenan. */
  partiallySuppressed?: boolean;
}

const EXISTING_MESSAGE =
  'Ya existe un paciente con este documento en la clínica: no se crea otro (se salta o se rellenan sus campos vacíos, según elijas al confirmar).';
const SUPPRESSED_MESSAGE =
  'Ya existe un paciente con este documento en la clínica y pidió la supresión de sus datos por privacidad: no se crea otro y no se rellenarán su teléfono, correo, dirección, notas ni contacto de emergencia.';

export interface DedupeResult {
  /** Filas nuevas: se crearán. */
  fresh: CandidateRow[];
  /** Ya existen en la clínica con el mismo tipo: se saltan o rellenan. */
  existing: (CandidateRow & { patientId: string })[];
  /** Duplicados y conflictos, para el informe. */
  issues: RowIssue[];
  /** Filas descartadas por repetirse en el fichero. */
  fileDuplicates: number;
  /** Filas descartadas por conflicto de tipo (son errores). */
  conflicts: number;
}

const DOC_COLUMN = 'Número de documento';

/**
 * Deduplicación por (tipo, nº de documento) dentro del fichero y contra los
 * pacientes vivos de la clínica (DX-107). La BD garantiza un solo paciente
 * vivo por nº de documento en la clínica (patients_tenant_doc_key), sin mirar
 * el tipo: el mismo número con OTRO tipo no es un duplicado sino un error
 * (o es otra persona, o el tipo está mal) y nunca se importa.
 *
 * Dentro del fichero gana la PRIMERA fila; las siguientes son duplicados.
 */
export function dedupeRows(
  rows: readonly CandidateRow[],
  existingDocs: readonly ExistingPatientDoc[],
  columnHeader: string | undefined,
): DedupeResult {
  const column = columnHeader ?? DOC_COLUMN;
  const byKey = new Map<string, ExistingPatientDoc>();
  for (const doc of existingDocs) byKey.set(doc.docKey, doc);
  const firstSeen = new Map<string, CandidateRow>();
  const result: DedupeResult = {
    fresh: [],
    existing: [],
    issues: [],
    fileDuplicates: 0,
    conflicts: 0,
  };
  for (const row of rows) {
    const key = docKey(row.data.docNumber);
    const label = `${row.data.docType} ${row.data.docNumber}`;
    const earlier = firstSeen.get(key);
    if (earlier) {
      if (earlier.data.docType === row.data.docType) {
        result.fileDuplicates += 1;
        result.issues.push({
          row: row.rowNumber,
          column,
          kind: 'DUPLICATE_FILE',
          message: `Repetido en el archivo: mismo documento que la fila ${earlier.rowNumber}. Se importa solo la primera.`,
          value: label,
        });
      } else {
        result.conflicts += 1;
        result.issues.push({
          row: row.rowNumber,
          column,
          kind: 'ERROR',
          message: `El número de documento ya aparece en la fila ${earlier.rowNumber} con otro tipo (${earlier.data.docType}).`,
          value: label,
        });
      }
      continue;
    }
    firstSeen.set(key, row);
    const match = byKey.get(key);
    if (!match) {
      result.fresh.push(row);
    } else if (match.docType === row.data.docType) {
      result.existing.push({ ...row, patientId: match.id });
      result.issues.push({
        row: row.rowNumber,
        column,
        kind: 'DUPLICATE_EXISTING',
        message: match.partiallySuppressed
          ? SUPPRESSED_MESSAGE
          : EXISTING_MESSAGE,
        value: label,
      });
    } else {
      result.conflicts += 1;
      result.issues.push({
        row: row.rowNumber,
        column,
        kind: 'ERROR',
        message: `Ya hay un paciente en la clínica con este número de documento registrado como ${match.docType}: revisa el tipo.`,
        value: label,
      });
    }
  }
  return result;
}
