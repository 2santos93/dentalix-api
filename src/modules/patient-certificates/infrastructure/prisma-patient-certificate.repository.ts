import { Injectable } from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { CLINIC_FISCAL_SELECT } from '../../../shared/clinic/clinic-fiscal';
import { readCertificateSnapshot } from '../domain/certificate-snapshot';
import type { CertificateTimesSource } from '../domain/certificate-rules';
import type { PatientCertificate } from '../domain/patient-certificate';
import type {
  ArchivePdf,
  ArchivedPdf,
  CertificateIssueContext,
  CertificateProfessional,
  CertificateSettings,
  EligibleAppointment,
  IssueContextResult,
  IssueResult,
  NewCertificateInput,
  PatientCertificateRepository,
  VoidResult,
} from '../domain/ports/patient-certificate-repository.port';

/** Lo que se lee de cada certificado (con los nombres de quien emitió/anuló). */
const CERTIFICATE_INCLUDE = {
  issuedBy: { select: { fullName: true } },
  voidedBy: { select: { fullName: true } },
} satisfies Prisma.PatientCertificateInclude;

type CertificateRow = Prisma.PatientCertificateGetPayload<{
  include: typeof CERTIFICATE_INCLUDE;
}>;

/** Un día `@db.Date` (medianoche UTC) como 'YYYY-MM-DD'. */
const civil = (d: Date | null): string | null =>
  d === null ? null : d.toISOString().slice(0, 10);
/** 'YYYY-MM-DD' como el `Date` que Prisma escribe en una columna DATE. */
const dateColumn = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

function toCertificate(row: CertificateRow): PatientCertificate {
  return {
    id: row.id,
    patientId: row.patientId,
    appointmentId: row.appointmentId,
    locationId: row.locationId,
    professionalMembershipId: row.professionalMembershipId,
    issuedById: row.issuedById,
    issuedByName: row.issuedBy?.fullName ?? null,
    kind: row.kind,
    number: row.number,
    issuedAt: row.issuedAt,
    attendedFrom: row.attendedFrom,
    attendedUntil: row.attendedUntil,
    timesSource: row.timesSource as CertificateTimesSource,
    restDays: row.restDays,
    restStartDate: civil(row.restStartDate),
    restEndDate: civil(row.restEndDate),
    diagnosis: row.diagnosis,
    snapshot: readCertificateSnapshot(row.snapshot),
    documentId: row.documentId,
    voidedAt: row.voidedAt,
    voidedById: row.voidedById,
    voidedByName: row.voidedBy?.fullName ?? null,
    voidReason: row.voidReason,
    voidedDocumentId: row.voidedDocumentId,
  };
}

/** Violación del único parcial «un vivo por cita y tipo». */
function isLiveDuplicate(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  const text = Array.isArray(target)
    ? target.join(',')
    : typeof target === 'string'
      ? target
      : '';
  return (
    text.includes('patient_certificates_live_key') ||
    text.includes('appointmentId')
  );
}

/** Motivo con el que se anula el documento archivado (CHECK 1..500). */
function documentVoidReason(reason: string): string {
  const text = `Certificado anulado: ${reason}`;
  return Array.from(text).slice(0, 500).join('');
}

/**
 * DX-306: certificados en Postgres, todo bajo `runWithTenant` (RLS FORCE): un
 * paciente, cita o certificado de otra clínica no existe. `tenants` no tiene
 * RLS: se acota por el tenant del contexto.
 */
@Injectable()
export class PrismaPatientCertificateRepository implements PatientCertificateRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  private async professional(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<CertificateProfessional | null> {
    const membership = await tx.clinicMembership.findFirst({
      where: { userId, deletedAt: null },
      select: {
        id: true,
        professionalLicense: true,
        professionalSpecialty: true,
        user: { select: { fullName: true } },
      },
    });
    if (!membership) return null;
    return {
      membershipId: membership.id,
      name: membership.user.fullName,
      license: membership.professionalLicense?.trim() || null,
      specialty: membership.professionalSpecialty?.trim() || null,
    };
  }

  loadIssueContext(
    patientId: string,
    appointmentId: string,
    issuerUserId: string,
  ): Promise<IssueContextResult> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          documentType: true,
          docTypeLabel: true,
          docNumber: true,
        },
      });
      if (!patient) return { kind: 'PATIENT_NOT_FOUND' };
      const appointment = await tx.appointment.findFirst({
        where: { id: appointmentId, patientId, deletedAt: null },
        select: {
          id: true,
          locationId: true,
          providerId: true,
          status: true,
          start: true,
          end: true,
          arrivedAt: true,
          completedAt: true,
        },
      });
      if (!appointment) return { kind: 'APPOINTMENT_NOT_FOUND' };
      const [location, tenant, provider, issuer] = await Promise.all([
        tx.location.findFirstOrThrow({
          where: { id: appointment.locationId },
          select: {
            id: true,
            name: true,
            address: true,
            healthRegistrationNumber: true,
            showHealthRegistrationNumber: true,
            timeZone: true,
            locale: true,
            hourCycle: true,
          },
        }),
        tx.tenant.findFirstOrThrow({
          where: { id: tenantId },
          select: {
            name: true,
            ...CLINIC_FISCAL_SELECT,
            certificateRestMaxDays: true,
            certificateRestPrintDiagnosis: true,
          },
        }),
        this.professional(tx, appointment.providerId),
        this.professional(tx, issuerUserId),
      ]);
      const { documentType, ...rest } = patient;
      const context: CertificateIssueContext = {
        patient: { ...rest, docType: documentType },
        appointment,
        location,
        clinic: {
          name: tenant.name,
          legalName: tenant.legalName,
          taxIdLabel: tenant.taxIdLabel,
          taxId: tenant.taxId,
        },
        settings: {
          restMaxDays: tenant.certificateRestMaxDays,
          restPrintDiagnosis: tenant.certificateRestPrintDiagnosis,
        },
        provider,
        issuer,
      };
      return { kind: 'OK', context };
    });
  }

  async issue(
    input: NewCertificateInput,
    archive: ArchivePdf,
  ): Promise<IssueResult> {
    const tenantId = this.tenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const live = await tx.patientCertificate.findFirst({
          where: {
            appointmentId: input.appointmentId,
            kind: input.kind,
            voidedAt: null,
          },
          select: { number: true },
        });
        if (live) return { kind: 'DUPLICATE', number: live.number };
        const created = await tx.patientCertificate.create({
          data: {
            tenantId,
            patientId: input.patientId,
            appointmentId: input.appointmentId,
            locationId: input.locationId,
            professionalMembershipId: input.professionalMembershipId,
            issuedById: input.issuedById,
            kind: input.kind,
            // Lo sustituye el trigger por el siguiente de la sede.
            number: 0,
            attendedFrom: input.attendedFrom,
            attendedUntil: input.attendedUntil,
            timesSource: input.timesSource,
            restDays: input.rest?.restDays ?? null,
            restStartDate: input.rest
              ? dateColumn(input.rest.restStartDate)
              : null,
            restEndDate: input.rest ? dateColumn(input.rest.restEndDate) : null,
            diagnosis: input.rest?.diagnosis ?? null,
            snapshot: input.snapshot as unknown as Prisma.InputJsonValue,
          },
          include: CERTIFICATE_INCLUDE,
        });
        const certificate = toCertificate(created);
        const pdf = await archive(certificate);
        await this.createDocument(
          tx,
          tenantId,
          certificate,
          pdf,
          input.issuedById,
        );
        const linked = await tx.patientCertificate.update({
          where: { id: certificate.id },
          data: { documentId: pdf.documentId },
          include: CERTIFICATE_INCLUDE,
        });
        return { kind: 'ISSUED', certificate: toCertificate(linked) };
      });
    } catch (error) {
      // Dos emisiones a la vez de la misma cita: la segunda choca con el
      // único parcial. Se relee el número del vivo para el 409.
      if (!isLiveDuplicate(error)) throw error;
      const live = await this.prisma.runWithTenant((tx) =>
        tx.patientCertificate.findFirst({
          where: {
            appointmentId: input.appointmentId,
            kind: input.kind,
            voidedAt: null,
          },
          select: { number: true },
        }),
      );
      return { kind: 'DUPLICATE', number: live?.number ?? 0 };
    }
  }

  private async createDocument(
    tx: Prisma.TransactionClient,
    tenantId: string,
    certificate: PatientCertificate,
    pdf: ArchivedPdf,
    uploadedById: string,
  ): Promise<void> {
    await tx.patientDocument.create({
      data: {
        id: pdf.documentId,
        tenantId,
        patientId: certificate.patientId,
        locationId: certificate.locationId,
        category: 'REPORT',
        originalName: pdf.originalName,
        mimeType: 'application/pdf',
        sizeBytes: pdf.sizeBytes,
        sha256: pdf.sha256,
        storageKey: pdf.storageKey,
        toothNumbers: [],
        uploadedById,
      },
    });
  }

  list(patientId: string): Promise<PatientCertificate[] | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: patientId },
        select: { id: true },
      });
      if (!patient) return null;
      const rows = await tx.patientCertificate.findMany({
        where: { patientId },
        orderBy: [{ issuedAt: 'desc' }, { number: 'desc' }],
        include: CERTIFICATE_INCLUDE,
      });
      return rows.map(toCertificate);
    });
  }

  get(patientId: string, id: string): Promise<PatientCertificate | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.patientCertificate.findFirst({
        where: { id, patientId },
        include: CERTIFICATE_INCLUDE,
      });
      return row ? toCertificate(row) : null;
    });
  }

  voidCertificate(
    patientId: string,
    id: string,
    actor: { userId: string; reason: string },
    authorize: (certificate: PatientCertificate) => void,
    archive: ArchivePdf,
  ): Promise<VoidResult> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Candado de la fila: dos anulaciones a la vez, una gana y la otra ve
      // la fila ya anulada (409).
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "patient_certificates"
         WHERE "id" = ${id}::uuid AND "patientId" = ${patientId}::uuid
         FOR UPDATE`;
      if (locked.length === 0) return { kind: 'NOT_FOUND' };
      const row = await tx.patientCertificate.findFirstOrThrow({
        where: { id },
        include: CERTIFICATE_INCLUDE,
      });
      const current = toCertificate(row);
      authorize(current);
      if (current.voidedAt !== null) return { kind: 'ALREADY_VOIDED' };
      const voided = toCertificate(
        await tx.patientCertificate.update({
          where: { id },
          data: {
            voidedAt: new Date(),
            voidedById: actor.userId,
            voidReason: actor.reason,
          },
          include: CERTIFICATE_INCLUDE,
        }),
      );
      // El PDF archivado al emitir queda anulado en la ficha (con el motivo)
      // y en su lugar se archiva el PDF con «ANULADO».
      if (current.documentId) {
        await tx.patientDocument.updateMany({
          where: { id: current.documentId, voidedAt: null },
          data: {
            voidedAt: new Date(),
            voidedById: actor.userId,
            voidReason: documentVoidReason(actor.reason),
          },
        });
      }
      const pdf = await archive(voided);
      await this.createDocument(tx, tenantId, voided, pdf, actor.userId);
      const linked = await tx.patientCertificate.update({
        where: { id },
        data: { voidedDocumentId: pdf.documentId },
        include: CERTIFICATE_INCLUDE,
      });
      return { kind: 'VOIDED', certificate: toCertificate(linked) };
    });
  }

  eligibleAppointments(
    patientId: string,
    locationIds: readonly string[] | undefined,
    limit: number,
  ): Promise<EligibleAppointment[] | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: { id: true },
      });
      if (!patient) return null;
      const rows = await tx.appointment.findMany({
        where: {
          patientId,
          deletedAt: null,
          status: AppointmentStatus.COMPLETED,
          ...(locationIds ? { locationId: { in: [...locationIds] } } : {}),
        },
        orderBy: { start: 'desc' },
        take: limit,
        select: {
          id: true,
          locationId: true,
          providerId: true,
          start: true,
          end: true,
          location: { select: { name: true } },
          patientCertificates: {
            where: { voidedAt: null },
            select: { kind: true },
          },
        },
      });
      const providerIds = [...new Set(rows.map((r) => r.providerId))];
      const users = await tx.user.findMany({
        where: { id: { in: providerIds } },
        select: { id: true, fullName: true },
      });
      const nameOf = new Map(users.map((u) => [u.id, u.fullName]));
      return rows.map((r) => ({
        id: r.id,
        locationId: r.locationId,
        locationName: r.location.name,
        start: r.start,
        end: r.end,
        providerName: nameOf.get(r.providerId) ?? null,
        liveKinds: r.patientCertificates.map((c) => c.kind),
      }));
    });
  }

  professionalLicense(userId: string): Promise<string | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const membership = await tx.clinicMembership.findFirst({
        where: { userId, deletedAt: null },
        select: { professionalLicense: true },
      });
      return membership?.professionalLicense?.trim() || null;
    });
  }

  getSettings(): Promise<CertificateSettings> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.tenant.findFirstOrThrow({
        where: { id: tenantId },
        select: {
          certificateRestMaxDays: true,
          certificateRestPrintDiagnosis: true,
        },
      });
      return {
        restMaxDays: row.certificateRestMaxDays,
        restPrintDiagnosis: row.certificateRestPrintDiagnosis,
      };
    });
  }

  setSettings(
    next: CertificateSettings,
  ): Promise<{ before: CertificateSettings; after: CertificateSettings }> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const [row] = await tx.$queryRaw<
        {
          certificateRestMaxDays: number;
          certificateRestPrintDiagnosis: boolean;
        }[]
      >`SELECT "certificateRestMaxDays", "certificateRestPrintDiagnosis"
          FROM "tenants" WHERE "id" = ${tenantId}::uuid FOR UPDATE`;
      const before: CertificateSettings = {
        restMaxDays: row.certificateRestMaxDays,
        restPrintDiagnosis: row.certificateRestPrintDiagnosis,
      };
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          certificateRestMaxDays: next.restMaxDays,
          certificateRestPrintDiagnosis: next.restPrintDiagnosis,
        },
      });
      return { before, after: next };
    });
  }
}
