import type { DocumentType, PatientImplantKind } from '@prisma/client';

/** Un componente colocado tal como lo ve la ficha (DX-191). */
export interface PatientImplant {
  id: string;
  patientId: string;
  locationId: string;
  locationName: string;
  professionalId: string;
  professionalName: string;
  /** Día civil de la colocación, `YYYY-MM-DD`. */
  placedOn: string;
  toothNumber: string;
  treatmentPlanItemId: string | null;
  kind: PatientImplantKind;
  manufacturer: string;
  system: string | null;
  reference: string;
  lot: string;
  udi: string | null;
  diameterMm: number | null;
  lengthMm: number | null;
  sanitaryRegistration: string | null;
  notes: string | null;
  createdAt: Date;
  voidedAt: Date | null;
  voidedById: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  cardDeliveredAt: Date | null;
}

/** Fila de «¿quién recibió este lote / esta referencia?». */
export interface ImplantLotMatch {
  implantId: string;
  patientId: string;
  patientName: string;
  patientDocument: string | null;
  phone: string | null;
  placedOn: string;
  toothNumber: string;
  kind: PatientImplantKind;
  manufacturer: string;
  system: string | null;
  reference: string;
  lot: string;
  professionalName: string;
  locationName: string;
  voided: boolean;
}

/** Fabricante con los sistemas que la clínica ya usó (autocompletar). */
export interface ImplantCatalogEntry {
  manufacturer: string;
  systems: string[];
}

/** Datos del paciente para la tarjeta (identidad, sin datos clínicos). */
export interface ImplantCardPatient {
  id: string;
  firstName: string;
  lastName: string;
  docType: DocumentType;
  /** DX-327: nombre libre del documento (R7); null = sin etiqueta. */
  docTypeLabel: string | null;
  docNumber: string | null;
  birthDate: Date | null;
}
