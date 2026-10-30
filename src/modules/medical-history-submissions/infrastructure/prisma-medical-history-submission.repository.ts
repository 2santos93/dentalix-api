import { Injectable } from '@nestjs/common';
import {
  DataConsentChannel,
  DataConsentScope,
  MedicalHistorySubmissionStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import {
  insertMedicalHistoryVersionInTx,
  latestMedicalHistoryVersionInTx,
  mapMedicalHistoryVersion,
} from '../../medical-history/infrastructure/repositories/prisma-medical-history.repository';
import { lockPatientAnamnesis } from '../../medical-history/infrastructure/repositories/anamnesis-lock';
import type { AnamnesisAnswers } from '../domain/anamnesis-questionnaire';
import type {
  MedicalHistorySubmission,
  SubmissionSummary,
} from '../domain/entities/medical-history-submission.entity';
import {
  type AcceptInput,
  type IssueRequestInput,
  type IssuedRequest,
  type MedicalHistorySubmissionRepository,
  OutdatedPolicyError,
  type PublicSubmissionView,
  type RequestAppointment,
  type RequestContext,
  type ReviewOutcome,
  type SubmissionDetail,
  type SubmitInput,
  type SubmitOutcome,
} from '../domain/ports/medical-history-submission-repository.port';

const SUMMARY_INCLUDE = {
  patient: { select: { id: true, firstName: true, lastName: true } },
  appointment: { select: { id: true, start: true } },
  location: { select: { id: true, name: true } },
  createdBy: { select: { fullName: true } },
  reviewedBy: { select: { fullName: true } },
} satisfies Prisma.MedicalHistorySubmissionInclude;

type Row = Prisma.MedicalHistorySubmissionGetPayload<Record<string, never>>;
type SummaryRow = Prisma.MedicalHistorySubmissionGetPayload<{
  include: typeof SUMMARY_INCLUDE;
}>;

function toEntity(row: Row): MedicalHistorySubmission {
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    appointmentId: row.appointmentId,
    locationId: row.locationId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    status: row.status,
    questionnaireVersion: row.questionnaireVersion,
    answers: (row.answers as AnamnesisAnswers | null) ?? null,
    submittedAt: row.submittedAt,
    reviewedById: row.reviewedById,
    reviewedAt: row.reviewedAt,
    rejectReason: row.rejectReason,
    resultingVersionId: row.resultingVersionId,
    createdById: row.createdById,
    createdAt: row.createdAt,
  };
}

function toSummary(row: SummaryRow): SubmissionSummary {
  return {
    id: row.id,
    patient: {
      id: row.patient.id,
      fullName: `${row.patient.firstName} ${row.patient.lastName}`.trim(),
    },
    appointment: row.appointment
      ? { id: row.appointment.id, start: row.appointment.start }
      : null,
    location: { id: row.location.id, name: row.location.name },
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    createdByName: row.createdBy.fullName,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    reviewedByName: row.reviewedBy?.fullName ?? null,
    rejectReason: row.rejectReason,
    resultingVersionId: row.resultingVersionId,
  };
}

/** La última decisión SENSITIVE_HEALTH del paciente es «autoriza». */
async function sensitiveHealthGranted(
  tx: Prisma.TransactionClient,
  patientId: string,
): Promise<boolean> {
  const latest = await tx.dataProcessingConsent.findFirst({
    where: { patientId, scope: DataConsentScope.SENSITIVE_HEALTH },
    orderBy: { recordedAt: 'desc' },
    select: { granted: true },
  });
  return latest?.granted === true;
}

/** Fuerza el ROLLBACK de una aceptación que llegó tarde. */
class SubmissionNotSubmittedError extends Error {
  constructor(readonly status: MedicalHistorySubmissionStatus) {
    super('submission is not SUBMITTED');
  }
}

/**
 * Envíos de la anamnesis por enlace (DX-099). Todo bajo RLS
 * (`runWithTenant`): un envío, un paciente o un token de otra clínica no
 * existen. Sin delete (trigger de la BD); el ciclo de vida lo vigila además
 * `medical_history_submissions_guard`.
 */
@Injectable()
export class PrismaMedicalHistorySubmissionRepository implements MedicalHistorySubmissionRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  loadRequestContext(patientId: string): Promise<RequestContext | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: {
          id: true,
          firstName: true,
          phone: true,
          reminderOptOutAt: true,
          contactChannel: true,
        },
      });
      if (!patient) return null;
      const [tenant, granted, policy] = await Promise.all([
        tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { name: true },
        }),
        sensitiveHealthGranted(tx, patientId),
        tx.privacyPolicyVersion.findFirst({
          where: { tenantId },
          select: { id: true },
        }),
      ]);
      return {
        patient,
        clinicName: tenant.name,
        sensitiveHealthGranted: granted,
        hasPrivacyPolicy: policy !== null,
      };
    });
  }

  findAppointment(appointmentId: string): Promise<RequestAppointment | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.appointment.findFirst({
        where: { id: appointmentId, deletedAt: null },
        select: {
          id: true,
          patientId: true,
          locationId: true,
          start: true,
          status: true,
        },
      }),
    );
  }

  issue(input: IssueRequestInput): Promise<IssuedRequest> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const locationId =
        input.locationId ?? (await this.tenantContext.writeLocationId(tx));
      // Un solo enlace vivo por paciente: emitir otro anula los que aún
      // esperaban respuesta (como reenviar la confirmación de cita, DX-005).
      await tx.medicalHistorySubmission.updateMany({
        where: {
          patientId: input.patientId,
          status: MedicalHistorySubmissionStatus.PENDING_PATIENT,
        },
        data: {
          status: MedicalHistorySubmissionStatus.EXPIRED,
          revokedAt: new Date(),
        },
      });
      const row = await tx.medicalHistorySubmission.create({
        data: {
          tenantId,
          patientId: input.patientId,
          appointmentId: input.appointmentId,
          locationId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          questionnaireVersion: input.questionnaireVersion,
          createdById: input.createdById,
        },
      });
      const location = await tx.location.findFirstOrThrow({
        where: { id: locationId },
        select: { defaultPhoneRegion: true },
      });
      return {
        submission: toEntity(row),
        locationPhoneRegion: location.defaultPhoneRegion,
      };
    });
  }

  listForPatient(
    patientId: string,
    limit: number,
  ): Promise<SubmissionSummary[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.medicalHistorySubmission.findMany({
        where: { patientId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        include: SUMMARY_INCLUDE,
      });
      return rows.map(toSummary);
    });
  }

  listInbox(
    status: MedicalHistorySubmissionStatus,
    limit: number,
  ): Promise<SubmissionSummary[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.medicalHistorySubmission.findMany({
        where: {
          status,
          patient: { deletedAt: null },
          ...this.tenantContext.locationScope(),
        },
        // Por revisar: las más antiguas primero (las que llevan más
        // esperando). El resto, las más recientes.
        orderBy:
          status === MedicalHistorySubmissionStatus.SUBMITTED
            ? [{ submittedAt: 'asc' }, { id: 'asc' }]
            : [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        include: SUMMARY_INCLUDE,
      });
      return rows.map(toSummary);
    });
  }

  countInbox(status: MedicalHistorySubmissionStatus): Promise<number> {
    return this.prisma.runWithTenant((tx) =>
      tx.medicalHistorySubmission.count({
        where: {
          status,
          patient: { deletedAt: null },
          ...this.tenantContext.locationScope(),
        },
      }),
    );
  }

  findDetail(id: string): Promise<SubmissionDetail | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.medicalHistorySubmission.findFirst({
        where: { id, patient: { deletedAt: null } },
        include: SUMMARY_INCLUDE,
      });
      if (!row) return null;
      return { submission: toEntity(row), summary: toSummary(row) };
    });
  }

  findByTokenHash(tokenHash: string): Promise<PublicSubmissionView | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.medicalHistorySubmission.findFirst({
        where: { tokenHash },
        include: {
          patient: { select: { firstName: true, deletedAt: true } },
        },
      });
      if (!row) return null;
      const [tenant, granted, policy] = await Promise.all([
        tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { name: true, logoUrl: true, primaryColor: true },
        }),
        sensitiveHealthGranted(tx, row.patientId),
        tx.privacyPolicyVersion.findFirst({
          where: { tenantId },
          orderBy: { version: 'desc' },
          select: {
            id: true,
            version: true,
            sensitiveHealthText: true,
            policyText: true,
          },
        }),
      ]);
      return {
        submission: toEntity(row),
        patientFirstName: row.patient.firstName,
        patientDeleted: row.patient.deletedAt !== null,
        clinic: tenant,
        sensitiveHealthGranted: granted,
        policy,
      };
    });
  }

  submit(input: SubmitInput): Promise<SubmitOutcome> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Un solo uso: la transición es condicional. Un segundo POST (o uno
      // después de caducar o de anularse) no encuentra la fila en
      // PENDING_PATIENT y no escribe nada.
      const { count } = await tx.medicalHistorySubmission.updateMany({
        where: {
          id: input.id,
          status: MedicalHistorySubmissionStatus.PENDING_PATIENT,
          revokedAt: null,
          expiresAt: { gt: input.now },
        },
        data: {
          status: MedicalHistorySubmissionStatus.SUBMITTED,
          answers: input.answers as unknown as Prisma.InputJsonValue,
          submittedAt: input.now,
        },
      });
      if (count === 0) return 'GONE';

      const audit = {
        tenantId,
        locationId: null,
        actor: { kind: 'patient' as const },
        patient: { kind: 'patient' as const, id: input.patientId },
        requestId: input.requestId,
        ip: input.evidence.ipAddress,
        userAgent: input.evidence.userAgent,
      };
      if (input.consentPolicyVersionId) {
        // La política tiene que ser la vigente (la que se le mostró).
        const current = await tx.privacyPolicyVersion.findFirst({
          where: { tenantId },
          orderBy: { version: 'desc' },
          select: { id: true },
        });
        if (current?.id !== input.consentPolicyVersionId) {
          throw new OutdatedPolicyError();
        }
        await tx.dataProcessingConsent.create({
          data: {
            tenantId,
            patientId: input.patientId,
            policyVersionId: current.id,
            scope: DataConsentScope.SENSITIVE_HEALTH,
            granted: true,
            channel: DataConsentChannel.PATIENT_LINK,
            recordedById: null,
            recordedAt: input.now,
            ipAddress: input.evidence.ipAddress,
            userAgent: input.evidence.userAgent?.slice(0, 512) ?? null,
          },
        });
        await writeAuditEvent(tx, {
          ...audit,
          action: 'CREATE',
          resourceType: 'DATA_CONSENT',
          resourceId: null,
          metadata: { origin: 'LINK', reason: 'ANAMNESIS_LINK' },
        });
      }
      // Sin respuestas en la auditoría: solo quién (el paciente), qué envío
      // y por dónde.
      await writeAuditEvent(tx, {
        ...audit,
        action: 'UPDATE',
        resourceType: 'MEDICAL_HISTORY_SUBMISSION',
        resourceId: input.id,
        metadata: { origin: 'LINK', reason: 'ANAMNESIS_SUBMITTED' },
      });
      return 'SUBMITTED';
    });
  }

  async accept(input: AcceptInput): Promise<ReviewOutcome> {
    const tenantId = this.requireTenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const locked = await this.lockSubmission(tx, input.id);
        if (!locked) return { kind: 'NOT_FOUND' };
        if (locked.status !== MedicalHistorySubmissionStatus.SUBMITTED) {
          return { kind: 'CONFLICT', status: locked.status };
        }
        // Bajo el candado por paciente (el mismo del guardado y de «Sin
        // cambios hoy»): la vigente que se usa para armar la versión es la
        // que de verdad queda debajo.
        await lockPatientAnamnesis(tx, tenantId, locked.patientId);
        const latest = await latestMedicalHistoryVersionInTx(
          tx,
          locked.patientId,
        );
        const version = await insertMedicalHistoryVersionInTx(tx, {
          tenantId,
          patientId: locked.patientId,
          data: input.build(latest ? mapMedicalHistoryVersion(latest) : null),
          createdById: input.reviewerId,
          source: 'PATIENT_FORM',
        });
        const { count } = await tx.medicalHistorySubmission.updateMany({
          where: {
            id: input.id,
            status: MedicalHistorySubmissionStatus.SUBMITTED,
          },
          data: {
            status: MedicalHistorySubmissionStatus.ACCEPTED,
            reviewedById: input.reviewerId,
            reviewedAt: new Date(),
            resultingVersionId: version.id,
          },
        });
        if (count === 0) {
          throw new SubmissionNotSubmittedError(locked.status);
        }
        const row = await tx.medicalHistorySubmission.findUniqueOrThrow({
          where: { id: input.id },
        });
        return { kind: 'OK', submission: toEntity(row) };
      });
    } catch (err) {
      if (err instanceof SubmissionNotSubmittedError) {
        return { kind: 'CONFLICT', status: err.status };
      }
      throw err;
    }
  }

  reject(input: {
    id: string;
    reviewerId: string;
    reason: string;
  }): Promise<ReviewOutcome> {
    return this.prisma.runWithTenant(async (tx) => {
      const locked = await this.lockSubmission(tx, input.id);
      if (!locked) return { kind: 'NOT_FOUND' };
      if (locked.status !== MedicalHistorySubmissionStatus.SUBMITTED) {
        return { kind: 'CONFLICT', status: locked.status };
      }
      const row = await tx.medicalHistorySubmission.update({
        where: { id: input.id },
        data: {
          status: MedicalHistorySubmissionStatus.REJECTED,
          reviewedById: input.reviewerId,
          reviewedAt: new Date(),
          rejectReason: input.reason,
        },
      });
      return { kind: 'OK', submission: toEntity(row) };
    });
  }

  revoke(input: { id: string; now: Date }): Promise<ReviewOutcome> {
    return this.prisma.runWithTenant(async (tx) => {
      const locked = await this.lockSubmission(tx, input.id);
      if (!locked) return { kind: 'NOT_FOUND' };
      if (locked.status !== MedicalHistorySubmissionStatus.PENDING_PATIENT) {
        return { kind: 'CONFLICT', status: locked.status };
      }
      const row = await tx.medicalHistorySubmission.update({
        where: { id: input.id },
        data: {
          status: MedicalHistorySubmissionStatus.EXPIRED,
          revokedAt: input.now,
        },
      });
      return { kind: 'OK', submission: toEntity(row) };
    });
  }

  /**
   * Bloquea la fila del envío hasta el COMMIT (bajo RLS): dos revisiones a la
   * vez se ordenan aquí y la segunda ve el estado que dejó la primera.
   */
  private async lockSubmission(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<{
    patientId: string;
    status: MedicalHistorySubmissionStatus;
  } | null> {
    const rows = await tx.$queryRaw<
      { patientId: string; status: MedicalHistorySubmissionStatus }[]
    >`SELECT "patientId", "status"
      FROM "medical_history_submissions"
      WHERE "id" = ${id}::uuid
      FOR UPDATE`;
    return rows[0] ?? null;
  }
}
