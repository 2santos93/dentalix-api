import { IMPORT_FIELDS } from './import-fields';
import type { IssueKind, RowIssue } from './row-validation';

/*
 * CSV que genera la importación (DX-107): la plantilla y el informe de errores.
 * Mismo formato que los demás CSV de la API (DX-145): UTF-8 con BOM y CRLF
 * (Excel abre bien las tildes), texto entre comillas y, contra la inyección
 * CSV, una celda que empieza por = + - @ (también tras espacios) o por
 * tabulador/CR se antepone con «'» para que la hoja no la ejecute como
 * fórmula. En el informe van cabeceras y valores del fichero subido: texto
 * de otra persona.
 */

const BOM = '﻿';
const FORMULA_START = /^[\s]*[=+\-@]|^[\t\r]/;

export function csvCell(value: string | number | null): string {
  if (value === null) return '""';
  if (typeof value === 'number') return String(value);
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function csv(lines: (string | number | null)[][]): string {
  return BOM + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Plantilla: las columnas admitidas y dos filas de ejemplo ficticias. */
export function templateCsv(): string {
  const example1: Record<string, string> = {
    tipo_documento: 'NATIONAL_ID',
    numero_documento: 'DOC-1000001',
    nombres: 'Ana María',
    apellidos: 'Ejemplo Gómez',
    fecha_nacimiento: '15/04/1988',
    sexo: 'F',
    telefono: '+00 000 000 0001',
    email: 'ana.ejemplo@example.com',
    direccion: 'Dirección de ejemplo 123',
    ocupacion: 'Docente',
    contacto_emergencia: 'Luis Ejemplo',
    telefono_emergencia: '+00 000 000 0002',
    notas: 'Fila de ejemplo: bórrala antes de importar',
  };
  const example2: Record<string, string> = {
    tipo_documento: 'PASSPORT',
    numero_documento: 'X1000002',
    nombres: 'Tomás',
    apellidos: 'Ejemplo Ruiz',
    fecha_nacimiento: '2014-09-02',
    sexo: 'M',
    notas: 'Fila de ejemplo: bórrala antes de importar',
  };
  return csv([
    IMPORT_FIELDS.map((f) => f.header),
    IMPORT_FIELDS.map((f) => example1[f.header] ?? ''),
    IMPORT_FIELDS.map((f) => example2[f.header] ?? ''),
  ]);
}

export const ISSUE_KIND_LABELS: Record<IssueKind, string> = {
  ERROR: 'Error',
  DUPLICATE_FILE: 'Repetido en el archivo',
  DUPLICATE_EXISTING: 'Ya existe en la clínica',
  MERGED: 'Sumada a otra fila',
  EXISTING_BALANCE: 'Ya tenía saldo migrado',
};

export const ISSUES_CSV_HEADER = ['Fila', 'Columna', 'Tipo', 'Motivo', 'Valor'];

/** Informe de errores y duplicados por fila, en el orden del fichero. */
export function issuesCsv(issues: readonly RowIssue[]): string {
  const sorted = [...issues].sort((a, b) => a.row - b.row);
  return csv([
    ISSUES_CSV_HEADER,
    ...sorted.map((i) => [
      i.row,
      i.column,
      ISSUE_KIND_LABELS[i.kind],
      i.message,
      i.value,
    ]),
  ]);
}
