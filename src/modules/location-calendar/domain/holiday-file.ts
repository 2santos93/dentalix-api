/**
 * Lo que devuelve un lector de festivos (CSV o ICS, spec §5.4), antes de
 * clasificar contra los festivos de la sede. Una entrada es un candidato o una
 * fila con error: las dos cuentan para `MAX_HOLIDAYS_PER_FILE`.
 */
export type HolidayFileFormat = 'CSV' | 'ICS';

export interface HolidayCandidate {
  /** Fila física del CSV o línea del `BEGIN:VEVENT` del ICS. */
  line: number;
  /** 'YYYY-MM-DD', ya validada y en rango. */
  date: string;
  /** Recortado, 1–120 caracteres, sin caracteres de control. */
  name: string;
  recurring: boolean;
}

/** Una fila que no se pudo leer. Los campos que sí se leyeron van rellenos. */
export interface HolidayRowError {
  line: number;
  date: string | null;
  name: string | null;
  recurring: boolean | null;
  message: string;
}

export interface ParsedHolidayFile {
  format: HolidayFileFormat;
  /** Ya expandidos (un evento de varios días da un candidato por día), en orden de fichero. */
  candidates: HolidayCandidate[];
  errors: HolidayRowError[];
}
