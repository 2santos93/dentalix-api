import { formatCertificateNumber } from '../domain/certificate-rules';
import type { PatientCertificate } from '../domain/patient-certificate';
import type { EligibleAppointment } from '../domain/ports/patient-certificate-repository.port';
import type {
  EligibleAppointmentDto,
  PatientCertificateDto,
} from './dto/patient-certificate.dto';

export function presentCertificate(
  c: PatientCertificate,
): PatientCertificateDto {
  const { version: _version, ...snapshot } = c.snapshot;
  return {
    id: c.id,
    patientId: c.patientId,
    appointmentId: c.appointmentId,
    locationId: c.locationId,
    kind: c.kind,
    number: c.number,
    numberLabel: formatCertificateNumber(c.number),
    issuedAt: c.issuedAt.toISOString(),
    issuedById: c.issuedById,
    issuedByName: c.issuedByName,
    attendedFrom: c.attendedFrom.toISOString(),
    attendedUntil: c.attendedUntil.toISOString(),
    timesSource: c.timesSource,
    restDays: c.restDays,
    restStartDate: c.restStartDate,
    restEndDate: c.restEndDate,
    diagnosis: c.diagnosis,
    hasDiagnosis: c.diagnosis !== null || c.diagnosisHidden === true,
    snapshot,
    documentId: c.documentId,
    voidedAt: c.voidedAt?.toISOString() ?? null,
    voidedByName: c.voidedByName,
    voidReason: c.voidReason,
    voidedDocumentId: c.voidedDocumentId,
  };
}

export function presentEligibleAppointment(
  a: EligibleAppointment,
): EligibleAppointmentDto {
  return {
    id: a.id,
    locationId: a.locationId,
    locationName: a.locationName,
    start: a.start.toISOString(),
    end: a.end.toISOString(),
    providerName: a.providerName,
    liveKinds: a.liveKinds,
  };
}
