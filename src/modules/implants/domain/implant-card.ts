import type { PatientImplantKind } from '@prisma/client';
import type {
  ImplantCardPatient,
  PatientImplant,
} from './entities/patient-implant.entity';
import {
  documentText,
  documentTypeName,
  type ClinicDocumentTypeNames,
} from '../../patients/domain/document-type';

export const IMPLANT_KIND_LABEL: Record<PatientImplantKind, string> = {
  IMPLANT: 'Implante',
  ABUTMENT: 'Pilar',
  GRAFT: 'Injerto',
  MEMBRANE: 'Membrana',
  OTHER: 'Otro',
};

export interface ImplantCardLocation {
  id: string;
  name: string;
  address: string | null;
}

/** Un componente en la tarjeta: solo lo que identifica el producto. */
export interface ImplantCardItem {
  id: string;
  toothNumber: string;
  kind: PatientImplantKind;
  kindLabel: string;
  manufacturer: string;
  system: string | null;
  reference: string;
  lot: string;
  udi: string | null;
  diameterMm: number | null;
  lengthMm: number | null;
  sanitaryRegistration: string | null;
  voided: boolean;
  voidedAt: Date | null;
  cardDeliveredAt: Date | null;
}

/**
 * Tarjeta de implante de UNA intervención (paciente + día de colocación).
 * Identidad del paciente, centro, fecha, profesional(es) y los componentes;
 * NUNCA diagnóstico, notas ni motivo de anulación (trazabilidad del implante
 * para el paciente: datos del implante y del portador, nada más).
 */
export interface ImplantCard {
  patientId: string;
  patientName: string;
  patientDocument: string | null;
  patientBirthDate: string | null;
  clinicName: string;
  locations: ImplantCardLocation[];
  placedOn: string;
  professionals: string[];
  items: ImplantCardItem[];
  /** Primera entrega registrada de la tarjeta (null si aún no se entregó). */
  deliveredAt: Date | null;
}

/** En vivo (DX-327, R17 y R18): el nombre visible de hoy y el número. */
function patientDocument(
  patient: ImplantCardPatient,
  names: ClinicDocumentTypeNames,
): string | null {
  return documentText(
    documentTypeName(patient.docType, patient.docTypeLabel, names),
    patient.docNumber?.trim() || null,
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/**
 * Compone la tarjeta. Puro. `implants` son los del paciente en ese día (en
 * cualquier orden): se ordenan por diente y luego por hora de registro, y
 * los anulados siguen, marcados, para que una tarjeta ya entregada no
 * «pierda» un componente sin explicación.
 */
export function composeImplantCard(input: {
  clinicName: string;
  patient: ImplantCardPatient;
  /** Nombres locales de la clínica (R16), leídos una vez por tarjeta. */
  documentTypeNames: ClinicDocumentTypeNames;
  placedOn: string;
  implants: PatientImplant[];
  locations: ImplantCardLocation[];
}): ImplantCard {
  const sorted = [...input.implants].sort(
    (a, b) =>
      a.toothNumber.localeCompare(b.toothNumber) ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const deliveries = sorted
    .map((i) => i.cardDeliveredAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  const locationIds = unique(sorted.map((i) => i.locationId));
  return {
    patientId: input.patient.id,
    patientName: `${input.patient.firstName} ${input.patient.lastName}`.trim(),
    patientDocument: patientDocument(input.patient, input.documentTypeNames),
    patientBirthDate: input.patient.birthDate
      ? input.patient.birthDate.toISOString().slice(0, 10)
      : null,
    clinicName: input.clinicName,
    locations: input.locations.filter((l) => locationIds.includes(l.id)),
    placedOn: input.placedOn,
    professionals: unique(sorted.map((i) => i.professionalName)),
    items: sorted.map((i) => ({
      id: i.id,
      toothNumber: i.toothNumber,
      kind: i.kind,
      kindLabel: IMPLANT_KIND_LABEL[i.kind],
      manufacturer: i.manufacturer,
      system: i.system,
      reference: i.reference,
      lot: i.lot,
      udi: i.udi,
      diameterMm: i.diameterMm,
      lengthMm: i.lengthMm,
      sanitaryRegistration: i.sanitaryRegistration,
      voided: i.voidedAt !== null,
      voidedAt: i.voidedAt,
      cardDeliveredAt: i.cardDeliveredAt,
    })),
    deliveredAt: deliveries[0] ?? null,
  };
}
