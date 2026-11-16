import {
  regionalFormat,
  type HourCycle,
} from '../../../shared/format/regional-format';
import {
  formatExternalOrderNumber,
  type ExternalOrderKind,
  type ExternalOrderStatus,
} from './external-order-rules';

/**
 * DX-572: foto de lo que imprime una orden, congelada al emitir (columna
 * `snapshot`, inalterable por trigger). Si después cambian el nombre del
 * paciente, el registro del profesional o la dirección de la sede, la orden
 * se reimprime igual. Texto libre, sin formato por país. El logo va aparte
 * (`clinicLogoKey`, DX-019-bis).
 */
export interface ExternalOrderSnapshot {
  version: 1;
  patient: {
    name: string;
    /** «{nombre del tipo} {número}» (DX-327/DX-524) o null sin número. */
    document: string | null;
    /** Años cumplidos en el día civil de la sede al emitir; null sin fecha. */
    ageYears: number | null;
  };
  professional: {
    name: string;
    license: string | null;
    specialty: string | null;
  };
  location: {
    name: string;
    address: string | null;
    /** DX-319: solo si la sede lo muestra en sus documentos. */
    healthRegistrationNumber: string | null;
    timeZone: string;
    locale: string;
    hourCycle: HourCycle;
  };
  clinic: {
    name: string;
    legalName: string | null;
    taxIdLabel: string | null;
    taxId: string | null;
  };
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/**
 * Lee la foto guardada (jsonb). Tolerante: un campo que falte sale vacío en
 * vez de romper la reimpresión; la escribe solo esta API.
 */
export function readExternalOrderSnapshot(
  value: unknown,
): ExternalOrderSnapshot {
  const root = obj(value);
  const patient = obj(root.patient);
  const professional = obj(root.professional);
  const location = obj(root.location);
  const clinic = obj(root.clinic);
  const age = patient.ageYears;
  return {
    version: 1,
    patient: {
      name: str(patient.name) ?? '',
      document: str(patient.document),
      ageYears:
        typeof age === 'number' && Number.isInteger(age) && age >= 0
          ? age
          : null,
    },
    professional: {
      name: str(professional.name) ?? '',
      license: str(professional.license),
      specialty: str(professional.specialty),
    },
    location: {
      name: str(location.name) ?? '',
      address: str(location.address),
      healthRegistrationNumber: str(location.healthRegistrationNumber),
      timeZone: str(location.timeZone) ?? 'UTC',
      locale: str(location.locale) ?? 'es',
      hourCycle: location.hourCycle === 'h12' ? 'h12' : 'h23',
    },
    clinic: {
      name: str(clinic.name) ?? '',
      legalName: str(clinic.legalName),
      taxIdLabel: str(clinic.taxIdLabel),
      taxId: str(clinic.taxId),
    },
  };
}

/** DX-572: una orden emitida, tal como la devuelve el repositorio. */
export interface ExternalOrder {
  id: string;
  patientId: string;
  locationId: string;
  appointmentId: string | null;
  professionalMembershipId: string;
  issuedById: string;
  issuedByName: string | null;
  kind: ExternalOrderKind;
  number: number;
  issuedAt: Date;
  status: ExternalOrderStatus;
  recipient: string;
  items: string[];
  toothNumbers: string[];
  clinicalNote: string | null;
  /** La nota existe pero se ocultó a quien pide (recepción). */
  clinicalNoteHidden?: boolean;
  templateId: string | null;
  snapshot: ExternalOrderSnapshot;
  clinicLogoKey: string | null;
  documentId: string | null;
  resultDocumentId: string | null;
  resultLinkedAt: Date | null;
  resultLinkedById: string | null;
  resultLinkedByName: string | null;
  voidedAt: Date | null;
  voidedById: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  voidedDocumentId: string | null;
}

export const EXTERNAL_ORDER_TITLES: Record<ExternalOrderKind, string> = {
  IMAGING: 'Orden de estudios de imagen',
  LAB: 'Orden de laboratorio clínico',
  SPECIALIST: 'Referencia a especialista',
  OTHER: 'Orden de estudios',
};

const RECIPIENT_LABEL: Record<ExternalOrderKind, string> = {
  IMAGING: 'Centro de imagen',
  LAB: 'Laboratorio',
  SPECIALIST: 'Especialista',
  OTHER: 'Destinatario',
};

const ITEMS_LABEL: Record<ExternalOrderKind, string> = {
  IMAGING: 'Estudios solicitados',
  LAB: 'Estudios solicitados',
  SPECIALIST: 'Motivo de la referencia',
  OTHER: 'Solicitado',
};

const FILE_PREFIX: Record<ExternalOrderKind, string> = {
  IMAGING: 'orden-imagen',
  LAB: 'orden-laboratorio',
  SPECIALIST: 'referencia',
  OTHER: 'orden',
};

/** Nombre del fichero: «orden-imagen-000123.pdf», «…-anulada.pdf». */
export function externalOrderFileName(
  kind: ExternalOrderKind,
  number: number,
  voided: boolean,
): string {
  return `${FILE_PREFIX[kind]}-${formatExternalOrderNumber(number)}${voided ? '-anulada' : ''}.pdf`;
}

/** Lo que pinta el PDF, ya escrito (el renderer no decide nada). */
export interface ExternalOrderPdfModel {
  title: string;
  numberLabel: string;
  dateLine: string;
  /** Cabecera: clínica, datos fiscales, sede, dirección, registro sanitario. */
  header: { clinic: string; lines: string[] };
  /** Bytes del logo congelado (PNG o JPEG) o null: sin logo. */
  logo: Buffer | null;
  /** Pares «etiqueta: valor» (paciente, documento, edad, destinatario). */
  fields: { label: string; value: string }[];
  itemsLabel: string;
  items: string[];
  teeth: string | null;
  /** La nota clínica, o null (sin nota o en la copia sin ella). */
  note: string | null;
  /** Aviso en gris de que la nota se omitió en esta copia, o null. */
  noteOmitted: string | null;
  signature: string[];
  issuedLine: string;
  /** «ANULADA» con su fecha y motivo, o null. */
  voided: { stamp: string; line: string } | null;
  /** Metadatos: la fecha de emisión, para que el PDF sea determinista. */
  issuedAt: Date;
  clinicName: string;
}

export const CLINICAL_NOTE_OMITTED_NOTE =
  'La orden lleva una nota clínica que no se incluye en esta copia.';

/**
 * Arma el texto del PDF desde la foto de la orden, con la fecha en la zona, el
 * locale y el reloj de la SEDE (congelados en la foto). `withNote`: la nota
 * clínica solo va en el PDF que se genera bajo demanda para los roles
 * clínicos y en la copia del paciente; la copia ARCHIVADA en sus documentos
 * (que ven los 4 roles) va sin ella, con un aviso.
 */
export function buildExternalOrderPdfModel(
  order: ExternalOrder,
  options: { withNote: boolean; logo?: Buffer | null },
): ExternalOrderPdfModel {
  const s = order.snapshot;
  const tz = s.location.timeZone;
  const fmt = regionalFormat({
    locale: s.location.locale,
    hourCycle: s.location.hourCycle,
  });

  const lines: string[] = [];
  if (s.clinic.legalName) lines.push(s.clinic.legalName);
  if (s.clinic.taxId) {
    lines.push(`${s.clinic.taxIdLabel ?? 'Id. fiscal'}: ${s.clinic.taxId}`);
  }
  lines.push(s.location.name);
  if (s.location.address) lines.push(s.location.address);
  if (s.location.healthRegistrationNumber) {
    lines.push(
      `Nº de registro sanitario: ${s.location.healthRegistrationNumber}`,
    );
  }

  const fields: { label: string; value: string }[] = [
    { label: 'Paciente', value: s.patient.name },
  ];
  if (s.patient.document) {
    fields.push({ label: 'Documento', value: s.patient.document });
  }
  if (s.patient.ageYears !== null) {
    fields.push({
      label: 'Edad',
      value: `${s.patient.ageYears} ${s.patient.ageYears === 1 ? 'año' : 'años'}`,
    });
  }
  fields.push({ label: RECIPIENT_LABEL[order.kind], value: order.recipient });

  const hasNote = order.clinicalNote !== null || order.clinicalNoteHidden;
  const note = options.withNote ? order.clinicalNote : null;

  const signature = [s.professional.name];
  if (s.professional.specialty) signature.push(s.professional.specialty);
  if (s.professional.license) {
    signature.push(`Nº de registro profesional: ${s.professional.license}`);
  }

  const voided =
    order.voidedAt !== null
      ? {
          stamp: 'ANULADA',
          line: `ANULADA el ${fmt.dateTime(order.voidedAt, tz)}. Motivo: ${order.voidReason ?? ''}`,
        }
      : null;

  return {
    title: EXTERNAL_ORDER_TITLES[order.kind],
    numberLabel: `Nº ${formatExternalOrderNumber(order.number)}`,
    dateLine: `Fecha: ${fmt.longDate(order.issuedAt, tz)}`,
    header: { clinic: s.clinic.name, lines },
    logo: options.logo ?? null,
    fields,
    itemsLabel: ITEMS_LABEL[order.kind],
    items: order.items,
    teeth:
      order.toothNumbers.length > 0
        ? `Dientes: ${order.toothNumbers.join(', ')}`
        : null,
    note,
    noteOmitted: !note && hasNote ? CLINICAL_NOTE_OMITTED_NOTE : null,
    signature,
    issuedLine: `Emitida el ${fmt.longDateTime(order.issuedAt, tz)} en ${s.location.name}.`,
    voided,
    issuedAt: order.issuedAt,
    clinicName: s.clinic.name,
  };
}
