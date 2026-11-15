import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ClinicRole } from '@prisma/client';
import {
  FILE_STORAGE,
  type FileStoragePort,
} from '../../../shared/storage/file-storage.port';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { requireLocationTimeZone } from '../../../shared/locations/location-time-zone';
import {
  isHourCycle,
  requireLocationFormat,
} from '../../../shared/locations/location-regional';
import { civilDateIn } from '../../../shared/time/civil-day';
import { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../patients/application/assert-patient-in-clinic';
import {
  documentText,
  documentTypeName,
} from '../../patients/domain/document-type';
import { DocumentTypeNamesReader } from '../../patients/domain/ports/document-type-names-repository.port';
import { storageKeyFor } from '../../patient-documents/domain/document-rules';
import {
  CERTIFICATE_LABEL,
  CERTIFICATE_MESSAGES,
  attendanceTimes,
  canIssue,
  canSeeDiagnosis,
  canVoid,
  checkRest,
  formatCertificateNumber,
  isValidRestMaxDays,
  normalizeVoidReason,
  notAttendedMessage,
  restErrorMessage,
  type CertificateKind,
  type RestValue,
} from '../domain/certificate-rules';
import type { CertificateSnapshot } from '../domain/certificate-snapshot';
import {
  buildCertificatePdfModel,
  certificateFileName,
  type PatientCertificate,
} from '../domain/patient-certificate';
import {
  PATIENT_CERTIFICATE_REPOSITORY,
  type ArchivePdf,
  type CertificateIssueContext,
  type CertificateSettings,
  type EligibleAppointment,
  type PatientCertificateRepository,
} from '../domain/ports/patient-certificate-repository.port';
import {
  CERTIFICATE_PDF_RENDERER,
  type CertificatePdfRenderer,
} from '../infrastructure/certificate-pdf.renderer';

/** Quien hace la petición (del token, nunca del cuerpo). */
export interface CertificateActor {
  userId: string;
  role: ClinicRole;
}

export interface IssueCertificateInput {
  kind: CertificateKind;
  appointmentId: string;
  restDays?: number;
  restStartDate?: string;
  diagnosis?: string | null;
}

export interface CertificatePdf {
  pdf: Buffer;
  fileName: string;
}

/** Cuántas citas atendidas ofrece el selector de la ficha. */
export const ELIGIBLE_APPOINTMENTS_LIMIT = 30;

const pdfName = (c: PatientCertificate): string =>
  certificateFileName(c.kind, c.number, c.voidedAt !== null);

/**
 * Genera el PDF de un certificado (desde su foto) y lo guarda en el almacén;
 * recuerda las claves guardadas para borrarlas si la transacción no confirma.
 */
class PdfArchiver {
  readonly keys: string[] = [];

  constructor(
    private readonly tenantId: string,
    private readonly renderer: CertificatePdfRenderer,
    private readonly storage: FileStoragePort,
  ) {}

  readonly archive: ArchivePdf = async (certificate) => {
    const pdf = await this.renderer.render(
      buildCertificatePdfModel(certificate),
    );
    const documentId = randomUUID();
    const storageKey = storageKeyFor(
      this.tenantId,
      documentId,
      'application/pdf',
    );
    await this.storage.save(storageKey, pdf, 'application/pdf');
    this.keys.push(storageKey);
    return {
      documentId,
      storageKey,
      sha256: createHash('sha256').update(pdf).digest('hex'),
      sizeBytes: pdf.length,
      originalName: pdfName(certificate),
    };
  };
}

/**
 * DX-306: certificados del paciente — justificante de asistencia (recepción,
 * roles clínicos y ADMIN) y certificado de reposo (DENTIST o ADMIN con
 * registro profesional) de una cita ATENDIDA de una sede permitida. Foto
 * inalterable, número por sede, PDF archivado en los documentos del paciente
 * (REPORT) y anulación con motivo, sin borrado.
 */
@Injectable()
export class PatientCertificatesUseCases {
  private readonly logger = new Logger('PatientCertificates');

  constructor(
    @Inject(PATIENT_CERTIFICATE_REPOSITORY)
    private readonly repo: PatientCertificateRepository,
    @Inject(CERTIFICATE_PDF_RENDERER)
    private readonly renderer: CertificatePdfRenderer,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
    private readonly tenantContext: TenantContextService,
    private readonly documentTypeNames: DocumentTypeNamesReader,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('Sin clínica en el contexto');
    return tenantId;
  }

  async issue(
    patientId: string,
    input: IssueCertificateInput,
    actor: CertificateActor,
  ): Promise<PatientCertificate> {
    if (!canIssue(input.kind, actor.role)) {
      throw new ForbiddenException(CERTIFICATE_MESSAGES.restRoleForbidden);
    }
    const loaded = await this.repo.loadIssueContext(
      patientId,
      input.appointmentId,
      actor.userId,
    );
    if (loaded.kind === 'PATIENT_NOT_FOUND') {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    if (loaded.kind === 'APPOINTMENT_NOT_FOUND') {
      throw new NotFoundException(CERTIFICATE_MESSAGES.appointmentNotFound);
    }
    const ctx = loaded.context;
    // Sede antes que estado: de otra sede no se dice nada más (403).
    this.tenantContext.assertLocationAllowed(ctx.appointment.locationId);
    const notAttended = notAttendedMessage(ctx.appointment.status);
    if (notAttended) throw new ConflictException(notAttended);

    const timeZone = requireLocationTimeZone(ctx.location);
    // Valida locale y reloj ahora: el PDF los usa (409 si faltan).
    requireLocationFormat(ctx.location);
    const times = attendanceTimes(ctx.appointment);

    let rest: RestValue | null = null;
    let professional = ctx.provider;
    if (input.kind === 'REST') {
      if (!ctx.issuer) {
        throw new ForbiddenException(CERTIFICATE_MESSAGES.issuerMissing);
      }
      const check = checkRest(
        {
          restDays: input.restDays,
          restStartDate: input.restStartDate,
          diagnosis: input.diagnosis,
        },
        {
          maxDays: ctx.settings.restMaxDays,
          printDiagnosis: ctx.settings.restPrintDiagnosis,
          attentionDay: civilDateIn(times.from, timeZone),
          professionalLicense: ctx.issuer.license,
        },
      );
      if (!check.ok) {
        throw new BadRequestException(restErrorMessage(check.errors));
      }
      rest = check.value;
      professional = ctx.issuer;
    } else if (!professional) {
      throw new ConflictException(CERTIFICATE_MESSAGES.providerMissing);
    }
    if (!professional) throw new Error('Profesional resuelto arriba');

    const snapshot = await this.snapshot(ctx, timeZone, professional);
    const archiver = new PdfArchiver(
      this.tenantId(),
      this.renderer,
      this.storage,
    );
    let result;
    try {
      result = await this.repo.issue(
        {
          patientId,
          appointmentId: ctx.appointment.id,
          locationId: ctx.appointment.locationId,
          professionalMembershipId: professional.membershipId,
          issuedById: actor.userId,
          kind: input.kind,
          attendedFrom: times.from,
          attendedUntil: times.until,
          timesSource: times.source,
          rest,
          snapshot,
        },
        archiver.archive,
      );
    } catch (error) {
      await this.discard(archiver.keys);
      throw error;
    }
    if (result.kind === 'DUPLICATE') {
      await this.discard(archiver.keys);
      throw new ConflictException(
        `Ya hay un ${CERTIFICATE_LABEL[input.kind]} vigente de esta cita (Nº ${formatCertificateNumber(result.number)}). Anúlalo para emitir otro.`,
      );
    }
    return result.certificate;
  }

  private async snapshot(
    ctx: CertificateIssueContext,
    timeZone: string,
    professional: {
      name: string;
      license: string | null;
      specialty: string | null;
    },
  ): Promise<CertificateSnapshot> {
    const names = await this.documentTypeNames.get(ctx.location.id);
    const { patient, location, clinic } = ctx;
    return {
      version: 1,
      patient: {
        name: `${patient.firstName} ${patient.lastName}`.trim(),
        document: documentText(
          documentTypeName(patient.docType, patient.docTypeLabel, names),
          patient.docNumber,
        ),
      },
      professional: {
        name: professional.name,
        license: professional.license,
        specialty: professional.specialty,
      },
      location: {
        name: location.name,
        address: location.address?.trim() || null,
        healthRegistrationNumber: location.showHealthRegistrationNumber
          ? location.healthRegistrationNumber?.trim() || null
          : null,
        timeZone,
        // requireLocationFormat ya los exigió.
        locale: location.locale as string,
        hourCycle: isHourCycle(location.hourCycle) ? location.hourCycle : 'h23',
      },
      clinic: {
        name: clinic.name,
        legalName: clinic.legalName?.trim() || null,
        taxIdLabel: clinic.taxIdLabel?.trim() || null,
        taxId: clinic.taxId?.trim() || null,
      },
    };
  }

  async list(
    patientId: string,
    viewer: CertificateActor,
  ): Promise<PatientCertificate[]> {
    const certificates = await this.repo.list(patientId);
    if (certificates === null) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    return certificates.map((c) => this.forViewer(c, viewer));
  }

  /** Recepción no ve el diagnóstico (salvo que emitiera el reposo). */
  forViewer(
    certificate: PatientCertificate,
    viewer: CertificateActor,
  ): PatientCertificate {
    return certificate.diagnosis !== null &&
      !canSeeDiagnosis(viewer, certificate)
      ? { ...certificate, diagnosis: null, diagnosisHidden: true }
      : certificate;
  }

  /** El PDF, generado ahora desde la foto (refleja la anulación). */
  async pdf(
    patientId: string,
    id: string,
    viewer: CertificateActor,
  ): Promise<CertificatePdf> {
    const certificate = await this.repo.get(patientId, id);
    if (!certificate)
      throw new NotFoundException(CERTIFICATE_MESSAGES.notFound);
    this.tenantContext.assertLocationAllowed(certificate.locationId);
    if (
      certificate.diagnosis !== null &&
      !canSeeDiagnosis(viewer, certificate)
    ) {
      throw new ForbiddenException(CERTIFICATE_MESSAGES.diagnosisHidden);
    }
    const pdf = await this.renderer.render(
      buildCertificatePdfModel(certificate),
    );
    return { pdf, fileName: pdfName(certificate) };
  }

  async void(
    patientId: string,
    id: string,
    reasonInput: unknown,
    actor: CertificateActor,
  ): Promise<PatientCertificate> {
    const reason = normalizeVoidReason(reasonInput);
    if (reason === null) {
      throw new BadRequestException(CERTIFICATE_MESSAGES.voidReason);
    }
    const archiver = new PdfArchiver(
      this.tenantId(),
      this.renderer,
      this.storage,
    );
    let result;
    try {
      result = await this.repo.voidCertificate(
        patientId,
        id,
        { userId: actor.userId, reason },
        (certificate) => {
          this.tenantContext.assertLocationAllowed(certificate.locationId);
          if (!canVoid(actor, certificate)) {
            throw new ForbiddenException(CERTIFICATE_MESSAGES.voidForbidden);
          }
        },
        archiver.archive,
      );
    } catch (error) {
      await this.discard(archiver.keys);
      throw error;
    }
    if (result.kind === 'NOT_FOUND') {
      throw new NotFoundException(CERTIFICATE_MESSAGES.notFound);
    }
    if (result.kind === 'ALREADY_VOIDED') {
      await this.discard(archiver.keys);
      throw new ConflictException(CERTIFICATE_MESSAGES.alreadyVoided);
    }
    return this.forViewer(result.certificate, actor);
  }

  async eligibleAppointments(
    patientId: string,
  ): Promise<EligibleAppointment[]> {
    const rows = await this.repo.eligibleAppointments(
      patientId,
      this.tenantContext.scopeLocationIds(),
      ELIGIBLE_APPOINTMENTS_LIMIT,
    );
    if (rows === null) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    return rows;
  }

  /** Lo que la web necesita para ofrecer (o no) el reposo. */
  async issuer(actor: CertificateActor): Promise<{
    canIssueAttendance: boolean;
    canIssueRest: boolean;
    professionalLicense: string | null;
  }> {
    const license = await this.repo.professionalLicense(actor.userId);
    return {
      canIssueAttendance: canIssue('ATTENDANCE', actor.role),
      canIssueRest: canIssue('REST', actor.role),
      professionalLicense: license,
    };
  }

  /** El objeto sin fila no es alcanzable por la API; borrarlo es higiene. */
  private async discard(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      try {
        // Excepción justificada al borrado blando: borra el OBJETO del almacén
        // de una emisión cuya fila no se confirmó, no una fila de la BD.
        // eslint-disable-next-line no-restricted-syntax
        await this.storage.delete(key);
      } catch (error) {
        this.logger.warn(
          `No se pudo borrar el PDF de una emisión fallida (error=${error instanceof Error ? error.name : 'NonError'})`,
        );
      }
    }
  }
}

/** En el orden en que se listan en `changedFields`. */
const SETTINGS_FIELDS: readonly (keyof CertificateSettings)[] = [
  'restMaxDays',
  'restPrintDiagnosis',
];

/**
 * Ajustes de los certificados de la clínica (leer: todos; cambiar: ADMIN, lo
 * exige la ruta). Si de verdad cambió algo, se audita con los campos
 * cambiados (CLINIC_SETTINGS · CERTIFICATE_SETTINGS). Aplica a la siguiente
 * emisión: lo ya emitido lleva su foto.
 */
@Injectable()
export class CertificateSettingsUseCases {
  constructor(
    @Inject(PATIENT_CERTIFICATE_REPOSITORY)
    private readonly repo: PatientCertificateRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  get(): Promise<CertificateSettings> {
    return this.repo.getSettings();
  }

  async update(
    input: { restMaxDays: unknown; restPrintDiagnosis: unknown },
    ctx: AuditRequestContext,
  ): Promise<CertificateSettings> {
    if (!isValidRestMaxDays(input.restMaxDays)) {
      throw new BadRequestException(CERTIFICATE_MESSAGES.restMaxDays);
    }
    if (typeof input.restPrintDiagnosis !== 'boolean') {
      throw new BadRequestException(CERTIFICATE_MESSAGES.printDiagnosis);
    }
    const { before, after } = await this.repo.setSettings({
      restMaxDays: input.restMaxDays,
      restPrintDiagnosis: input.restPrintDiagnosis,
    });
    const changedFields = SETTINGS_FIELDS.filter(
      (field) => before[field] !== after[field],
    );
    if (changedFields.length > 0) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        // Ajuste de TODA la clínica, sin la sede activa de quien lo cambia.
        locationId: null,
        actor: {
          kind: 'user',
          userId: ctx.actor.userId,
          role: ctx.actor.role,
        },
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: null,
        patient: null,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { reason: 'CERTIFICATE_SETTINGS', changedFields },
      });
    }
    return after;
  }
}
