import { IMPLANT_KIND_LABEL } from './implant-card';
import type { ImplantLotMatch } from './entities/patient-implant.entity';

/*
 * CSV de «¿quién recibió este lote / esta referencia?» (DX-191). Datos
 * personales de varios pacientes: solo ADMIN y cada descarga queda auditada.
 * Mismo formato que la cartera (DX-145): UTF-8 con BOM, CRLF, texto entre
 * comillas y celdas que empiezan por = + - @ prefijadas con «'» (inyección
 * CSV).
 */
export const IMPLANT_LOT_CSV_HEADER = [
  'Paciente',
  'Documento',
  'Teléfono',
  'Fecha de colocación',
  'Diente',
  'Tipo',
  'Fabricante',
  'Sistema',
  'Referencia (REF)',
  'Lote',
  'Profesional',
  'Sede',
  'Anulado',
] as const;

const FORMULA_START = /^[=+\-@\t\r]/;

function text(value: string | null): string {
  const raw = (value ?? '').replace(/[\r\n]+/g, ' ');
  const safe = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toImplantLotCsv(rows: readonly ImplantLotMatch[]): string {
  const lines: string[] = [IMPLANT_LOT_CSV_HEADER.join(',')];
  for (const row of rows) {
    lines.push(
      [
        text(row.patientName),
        text(row.patientDocument),
        text(row.phone),
        row.placedOn,
        row.toothNumber,
        IMPLANT_KIND_LABEL[row.kind],
        text(row.manufacturer),
        text(row.system),
        text(row.reference),
        text(row.lot),
        text(row.professionalName),
        text(row.locationName),
        row.voided ? 'Sí' : 'No',
      ].join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
