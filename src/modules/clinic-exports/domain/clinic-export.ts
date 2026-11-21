import type { ClinicExportStatus } from '@prisma/client';

/** Nombre del trabajo que genera el ZIP (cola de DX-085). */
export const CLINIC_EXPORT_BUILD_JOB = 'clinic-exports.build';
/** Nombre del trabajo diferido que borra el fichero a los 7 días. */
export const CLINIC_EXPORT_PURGE_JOB = 'clinic-exports.purge-file';

/** El enlace de descarga vale 24 h desde que el ZIP está listo. */
export const DOWNLOAD_WINDOW_HOURS = 24;
/** El fichero se borra del almacén a los 7 días de terminar. */
export const FILE_RETENTION_DAYS = 7;
/** Vida de la URL firmada del almacén que devuelve la descarga. */
export const SIGNED_URL_TTL_SECONDS = 60;
/** Una exportación en curso de más de esto se da por muerta al pedir otra. */
export const STALE_AFTER_HOURS = 6;
/** Filas por página (keyset): lo único que se tiene en memoria por fichero. */
export const EXPORT_PAGE_SIZE = 1000;
/** Intentos del trabajo que genera el ZIP. */
export const BUILD_MAX_ATTEMPTS = 3;
/** Exportaciones que enseña el historial de Ajustes. */
export const HISTORY_LIMIT = 20;

/** Ruta de la pantalla en la web (el email enlaza aquí, nunca al fichero). */
export const CLINIC_EXPORT_SETTINGS_PATH = '/settings/exportar-datos';

export const CLINIC_EXPORT_FORBIDDEN_MESSAGE =
  'Solo un administrador de la clínica puede exportar sus datos.';
export const CLINIC_EXPORT_BREAK_GLASS_MESSAGE =
  'El acceso de soporte no puede exportar los datos de la clínica.';
export const CLINIC_EXPORT_IN_PROGRESS_MESSAGE =
  'Ya hay una exportación en curso. Espera a que termine para pedir otra.';
export const CLINIC_EXPORT_NOT_FOUND_MESSAGE =
  'No encontramos esa exportación en esta clínica.';
export const CLINIC_EXPORT_NOT_READY_MESSAGE =
  'La exportación todavía no está lista para descargar.';
export const CLINIC_EXPORT_ALREADY_DOWNLOADED_MESSAGE =
  'Esta exportación ya se descargó: el enlace es de un solo uso. Pide una exportación nueva.';
export const CLINIC_EXPORT_EXPIRED_MESSAGE =
  'El enlace de esta exportación caducó (vale 24 horas). Pide una exportación nueva.';
export const CLINIC_EXPORT_FAILED_MESSAGE =
  'Esta exportación falló. Pide una exportación nueva.';

/** Códigos de fallo que se guardan (sin detalle técnico ni datos). */
export type ClinicExportErrorCode =
  'BUILD_FAILED' | 'TOO_LARGE' | 'STALE' | 'LEASE_EXPIRED';

/**
 * Estado que ve el ADMIN: el de la fila más lo que el tiempo y la descarga
 * le hicieron a una READY.
 */
export type ClinicExportState =
  'PENDING' | 'RUNNING' | 'READY' | 'DOWNLOADED' | 'EXPIRED' | 'FAILED';

export interface ClinicExportRecord {
  id: string;
  status: ClinicExportStatus;
  requestedById: string;
  requestedByName: string | null;
  requestedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
  sizeBytes: number | null;
  fileCount: number | null;
  rowCounts: Record<string, number> | null;
  downloadExpiresAt: Date | null;
  downloadedAt: Date | null;
  downloadedByName: string | null;
  fileDeletedAt: Date | null;
}

export interface ClinicExportView {
  id: string;
  state: ClinicExportState;
  requestedByName: string | null;
  requestedAt: Date;
  completedAt: Date | null;
  sizeBytes: number | null;
  fileCount: number | null;
  totalRows: number | null;
  downloadExpiresAt: Date | null;
  downloadedAt: Date | null;
  downloadedByName: string | null;
  errorCode: string | null;
  canDownload: boolean;
}

export function stateOf(
  record: Pick<
    ClinicExportRecord,
    'status' | 'downloadedAt' | 'downloadExpiresAt' | 'fileDeletedAt'
  >,
  now: Date,
): ClinicExportState {
  if (record.status !== 'READY') return record.status;
  if (record.downloadedAt) return 'DOWNLOADED';
  if (
    record.fileDeletedAt ||
    !record.downloadExpiresAt ||
    record.downloadExpiresAt.getTime() <= now.getTime()
  ) {
    return 'EXPIRED';
  }
  return 'READY';
}

export function viewOf(
  record: ClinicExportRecord,
  now: Date,
): ClinicExportView {
  const state = stateOf(record, now);
  return {
    id: record.id,
    state,
    requestedByName: record.requestedByName,
    requestedAt: record.requestedAt,
    completedAt: record.completedAt,
    sizeBytes: record.sizeBytes,
    fileCount: record.fileCount,
    totalRows: record.rowCounts
      ? Object.values(record.rowCounts).reduce((a, b) => a + b, 0)
      : null,
    downloadExpiresAt: record.downloadExpiresAt,
    downloadedAt: record.downloadedAt,
    downloadedByName: record.downloadedByName,
    errorCode: record.errorCode,
    canDownload: state === 'READY',
  };
}

/** Clave del ZIP en el almacén: solo ids (sin PII). */
export function exportFileKey(tenantId: string, exportId: string): string {
  return `clinic-exports/${tenantId}/${exportId}.zip`;
}

/** Nombre del fichero que descarga el navegador. */
export function exportFileName(completedAt: Date): string {
  return `exportacion-dentalix-${completedAt.toISOString().slice(0, 10)}.zip`;
}

/** «2,4 MB» (separador decimal coma, como el resto de la interfaz en español). */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1).replace('.', ',')} ${units[unit]}`;
}
