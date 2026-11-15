import { regionalFormat } from '../../../shared/format/regional-format';
import type { CertificateSnapshot } from './certificate-snapshot';
import {
  formatCertificateNumber,
  type CertificateKind,
  type CertificateTimesSource,
} from './certificate-rules';

/** DX-306: un certificado emitido, tal como lo devuelve el repositorio. */
export interface PatientCertificate {
  id: string;
  patientId: string;
  appointmentId: string;
  locationId: string;
  professionalMembershipId: string;
  issuedById: string;
  issuedByName: string | null;
  kind: CertificateKind;
  number: number;
  issuedAt: Date;
  attendedFrom: Date;
  attendedUntil: Date;
  timesSource: CertificateTimesSource;
  restDays: number | null;
  /** 'YYYY-MM-DD' */
  restStartDate: string | null;
  restEndDate: string | null;
  diagnosis: string | null;
  /** El diagnóstico existe pero se ocultó a quien pide (recepción). */
  diagnosisHidden?: boolean;
  snapshot: CertificateSnapshot;
  documentId: string | null;
  voidedAt: Date | null;
  voidedById: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  voidedDocumentId: string | null;
}

/** Lo que pinta el PDF, ya escrito (el renderer no decide nada). */
export interface CertificatePdfModel {
  title: string;
  numberLabel: string;
  /** Cabecera: clínica, datos fiscales, sede, dirección, registro sanitario. */
  header: { clinic: string; lines: string[] };
  paragraphs: string[];
  /** Notas en gris bajo el cuerpo (p. ej. horas programadas). */
  notes: string[];
  signature: string[];
  issuedLine: string;
  /** «ANULADO» con su fecha y motivo, o null. */
  voided: { stamp: string; line: string } | null;
  /** Metadatos: fechas fijas (la emisión) para que el PDF sea determinista. */
  issuedAt: Date;
  clinicName: string;
}

export const CERTIFICATE_TITLES: Record<CertificateKind, string> = {
  ATTENDANCE: 'Justificante de asistencia',
  REST: 'Certificado de reposo',
};

const FILE_PREFIX: Record<CertificateKind, string> = {
  ATTENDANCE: 'justificante',
  REST: 'certificado-reposo',
};

/** Nombre del fichero: «justificante-000123.pdf», «…-anulado.pdf». */
export function certificateFileName(
  kind: CertificateKind,
  number: number,
  voided: boolean,
): string {
  return `${FILE_PREFIX[kind]}-${formatCertificateNumber(number)}${voided ? '-anulado' : ''}.pdf`;
}

const patientPhrase = (s: CertificateSnapshot): string =>
  s.patient.document
    ? `${s.patient.name}, con ${s.patient.document},`
    : s.patient.name;

/**
 * Arma el texto del PDF desde la foto del certificado, con fechas y horas en
 * la zona, el locale y el reloj de la SEDE (congelados en la foto). El
 * justificante solo dice que asistió a consulta: nunca lleva diagnóstico.
 */
/**
 * `withDiagnosis`: el diagnóstico de un reposo solo se pinta en el PDF que se
 * genera bajo demanda para quien puede verlo (roles clínicos o quien lo
 * emitió). La copia ARCHIVADA en los documentos del paciente (que ven los 4
 * roles) y la copia pública por WhatsApp van SIN él, con una nota.
 */
export const DIAGNOSIS_OMITTED_NOTE =
  'El diagnóstico consta en el certificado emitido y no se incluye en esta copia.';

export function buildCertificatePdfModel(
  certificate: PatientCertificate,
  options: { withDiagnosis: boolean },
): CertificatePdfModel {
  const s = certificate.snapshot;
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

  const day = fmt.longDate(certificate.attendedFrom, tz);
  const from = fmt.time(certificate.attendedFrom, tz);
  const until = fmt.time(certificate.attendedUntil, tz);
  const paragraphs: string[] = [];
  const notes: string[] = [];
  if (certificate.kind === 'ATTENDANCE') {
    paragraphs.push(
      `Se hace constar que ${patientPhrase(s)} asistió a consulta en ${s.location.name} el ${day}, de ${from} a ${until}.`,
    );
    if (certificate.timesSource === 'SCHEDULED') {
      notes.push(
        'Horas programadas de la cita: no constan las horas reales de llegada y salida.',
      );
    }
  } else {
    const days = certificate.restDays ?? 0;
    const start = fmt.civilLongDate(certificate.restStartDate ?? '', {
      weekday: false,
    });
    const end = fmt.civilLongDate(certificate.restEndDate ?? '', {
      weekday: false,
    });
    paragraphs.push(
      `Se hace constar que ${patientPhrase(s)} recibió atención en consulta en ${s.location.name} el ${day} y requiere reposo de ${days} ${days === 1 ? 'día' : 'días'}, desde el ${start} hasta el ${end}, ambos incluidos.`,
    );
    if (certificate.diagnosis && options.withDiagnosis) {
      paragraphs.push(`Diagnóstico: ${certificate.diagnosis}`);
    } else if (certificate.diagnosis || certificate.diagnosisHidden) {
      notes.push(DIAGNOSIS_OMITTED_NOTE);
    }
  }
  paragraphs.push(
    'Se extiende el presente a petición de la persona interesada, para los fines que estime convenientes.',
  );

  const signature = [s.professional.name];
  if (s.professional.specialty) signature.push(s.professional.specialty);
  if (s.professional.license) {
    signature.push(`Nº de registro profesional: ${s.professional.license}`);
  }

  const voided =
    certificate.voidedAt !== null
      ? {
          stamp: 'ANULADO',
          line: `ANULADO el ${fmt.dateTime(certificate.voidedAt, tz)}. Motivo: ${certificate.voidReason ?? ''}`,
        }
      : null;

  return {
    title: CERTIFICATE_TITLES[certificate.kind],
    numberLabel: `Nº ${formatCertificateNumber(certificate.number)}`,
    header: { clinic: s.clinic.name, lines },
    paragraphs,
    notes,
    signature,
    issuedLine: `Emitido el ${fmt.longDateTime(certificate.issuedAt, tz)} en ${s.location.name}.`,
    voided,
    issuedAt: certificate.issuedAt,
    clinicName: s.clinic.name,
  };
}
