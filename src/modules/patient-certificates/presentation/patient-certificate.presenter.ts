import { formatCertificateNumber } from '../domain/certificate-rules';
import type { PatientCertificate } from '../domain/patient-certificate';
import type { EligibleAppointment } from '../domain/ports/patient-certificate-repository.port';
import type {
  CertificateCopySent,
  PublicCertificateCopyView,
} from '../application/certificate-copies.use-cases';
import type {
  CertificateCopySentDto,
  EligibleAppointmentDto,
  PatientCertificateDto,
  PublicCertificateCopyDto,
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

export function presentCopySent(
  sent: CertificateCopySent,
): CertificateCopySentDto {
  return {
    sentAt: sent.sentAt.toISOString(),
    expiresAt: sent.expiresAt.toISOString(),
    destinationMasked: sent.destinationMasked,
    recipientKind: sent.recipientKind,
    whatsapp: sent.whatsapp,
  };
}

export function presentPublicCopy(
  view: PublicCertificateCopyView,
): PublicCertificateCopyDto {
  const c = view.certificate;
  const { timeZone, locale, hourCycle } = c.snapshot.location;
  const { version: _version, ...snapshot } = c.snapshot;
  return {
    status: view.status,
    clinic: view.clinic,
    expiresAt: view.expiresAt.toISOString(),
    voidedAt:
      view.status === 'VOIDED' ? (view.voidedAt?.toISOString() ?? null) : null,
    format: { timeZone, locale, hourCycle },
    certificate:
      view.status === 'AVAILABLE'
        ? {
            kind: c.kind,
            numberLabel: formatCertificateNumber(c.number),
            issuedAt: c.issuedAt.toISOString(),
            attendedFrom: c.attendedFrom.toISOString(),
            attendedUntil: c.attendedUntil.toISOString(),
            timesSource: c.timesSource,
            restDays: c.restDays,
            restStartDate: c.restStartDate,
            restEndDate: c.restEndDate,
            diagnosis: c.diagnosis,
            snapshot,
          }
        : null,
  };
}
