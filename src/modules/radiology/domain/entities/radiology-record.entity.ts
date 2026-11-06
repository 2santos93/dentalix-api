/**
 * DX-544 · Expediente de rayos X de una sede: los documentos regulatorios con
 * vencimiento (la licencia de práctica y el informe de control de calidad de
 * un tercero). Cada uno es de una sede y, si se quiere, de un equipo de rayos
 * X de ESA sede (DX-542). No se borra: se anula con motivo.
 */
export const RADIOLOGY_RECORD_KINDS = ['LICENSE', 'QUALITY_CONTROL'] as const;
export type RadiologyRecordKind = (typeof RADIOLOGY_RECORD_KINDS)[number];

/**
 * Categoría de la licencia: I (periapical) o II (panorámica, tomografía oral).
 * Solo la lleva una licencia.
 */
export const RADIOLOGY_LICENSE_CATEGORIES = ['I', 'II'] as const;
export type RadiologyLicenseCategory =
  (typeof RADIOLOGY_LICENSE_CATEGORIES)[number];

/**
 * Estado en el día de la sede. `RENEWED`: hay otro documento vivo del mismo
 * tipo, sede y equipo que vence después (ya se renovó; no avisa).
 */
export const RADIOLOGY_STATUSES = [
  'OVERDUE',
  'DUE_SOON',
  'UP_TO_DATE',
  'RENEWED',
] as const;
export type RadiologyStatus = (typeof RADIOLOGY_STATUSES)[number];

export interface RadiologyRecord {
  id: string;
  tenantId: string;
  locationId: string;
  /** Equipo de rayos X de la MISMA sede (DX-542) o `null` (toda la sede). */
  equipmentId: string | null;
  kind: RadiologyRecordKind;
  /** Solo en una licencia (obligatoria allí). */
  category: RadiologyLicenseCategory | null;
  /** Nº de la licencia o resolución, o del informe (obligatorio en la licencia). */
  reference: string | null;
  /** Autoridad que expide la licencia o empresa que hizo el control. */
  issuer: string;
  /** Día civil (YYYY-MM-DD). */
  issuedOn: string;
  /** Día civil del vencimiento (explícito o calculado al guardar). */
  expiresOn: string;
  /** Encargado u oficial de protección radiológica del personal… */
  officerUserId: string | null;
  /** …o escrito a mano (nunca los dos). */
  officerName: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
}

/** Fila con lo que la lista y los avisos necesitan al lado. */
export interface RadiologyRecordRecord extends RadiologyRecord {
  locationName: string;
  /** Zona de la sede: su «hoy» decide vencido / vence pronto. */
  locationTimeZone: string | null;
  equipmentName: string | null;
  /** Nombre del miembro del personal (si es del personal). */
  officerMemberName: string | null;
  /**
   * Hay otro documento VIVO del mismo tipo, sede y equipo que vence después:
   * este ya se renovó.
   */
  renewed: boolean;
}
