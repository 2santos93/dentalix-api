import { Injectable } from '@nestjs/common';
import { ClinicRole, Prisma, TreatmentPlanStatus } from '@prisma/client';
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { resolveReferenceLocation } from '../../../shared/locations/reference-location';
import { requireLocationTimeZone } from '../../../shared/locations/location-time-zone';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import {
  loadNoticeResponsibles,
  loadTenantMajorityAge,
} from '../../patients/infrastructure/notices/notice-context';
import type {
  PublicSignatureContext,
  SignatureRequestListRow,
  SignatureRequestRecord,
} from '../domain/entities/signature-request.entity';
import type {
  CreateSignatureRequestRepoInput,
  LockedWrite,
  PublicRequestEvidence,
  RevokeOutcome,
  SignaturePlanOption,
  SignatureProfessional,
  SignatureRecipientContext,
  SignatureRequestRepository,
} from '../domain/ports/signature-request-repository.port';

/**
 * Quien puede firmar un consentimiento como profesional: la MISMA regla que
 * la firma en la clínica (`patient-consents.controller`, CLINICAL_ROLES), con
 * la membresía y el usuario vivos.
 */
const PROFESSIONAL_ROLES: ClinicRole[] = CLINICAL_ROLES;
const PROFESSIONAL_SELECT = {
  role: true,
  user: { select: { id: true, fullName: true } },
} as const;

const LIST_INCLUDE = {
  createdBy: { select: { fullName: true } },
  consent: {
    select: {
      id: true,
      ipAddress: true,
      countersignature: { select: { signedAt: true } },
    },
  },
} satisfies Prisma.SignatureRequestInclude;

type ListRow = Prisma.SignatureRequestGetPayload<{
  include: typeof LIST_INCLUDE;
}>;

function toRecord(
  row: Prisma.SignatureRequestGetPayload<object>,
): SignatureRequestRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    locationId: row.locationId,
    patientId: row.patientId,
    type: row.type,
    channel: row.channel,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    treatmentPlanId: row.treatmentPlanId,
    title: row.title,
    body: row.body,
    professionalUserId: row.professionalUserId,
    professionalName: row.professionalName,
    signerType: row.signerType,
    signerName: row.signerName,
    signerDocument: row.signerDocument,
    destination: row.destination,
    destinationMasked: row.destinationMasked,
    tokenHash: row.tokenHash,
    codeHash: row.codeHash,
    codeExpiresAt: row.codeExpiresAt,
    codeSentAt: row.codeSentAt,
    codeSendCount: row.codeSendCount,
    failedAttempts: row.failedAttempts,
    lockedAt: row.lockedAt,
    sessionHash: row.sessionHash,
    sessionExpiresAt: row.sessionExpiresAt,
    expiresAt: row.expiresAt,
    openedAt: row.openedAt,
    verifiedAt: row.verifiedAt,
    signedAt: row.signedAt,
    revokedAt: row.revokedAt,
    createdById: row.createdById,
    createdAt: row.createdAt,
  };
}

function toListRow(row: ListRow): SignatureRequestListRow {
  const { createdBy, consent, ...request } = row;
  return {
    request: toRecord(request),
    sentByName: createdBy.fullName,
    consent: consent
      ? {
          id: consent.id,
          ipAddress: consent.ipAddress,
          countersignedAt: consent.countersignature?.signedAt ?? null,
        }
      : null,
  };
}

/**
 * Firma a distancia en Postgres (DX-243). Todo bajo `runWithTenant`: con la
 * RLS FORCE, una solicitud, un paciente o un token de otra clínica no
 * existen. `tenants` y `users` no tienen RLS: se acotan por el tenant del
 * contexto.
 */
@Injectable()
export class PrismaSignatureRequestRepository implements SignatureRequestRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  loadRecipientContext(
    patientId: string,
  ): Promise<SignatureRecipientContext | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: {
          firstName: true,
          lastName: true,
          birthDate: true,
          email: true,
          emergencyContactName: true,
          reminderOptOutAt: true,
          contactChannel: true,
        },
      });
      if (!patient) return null;
      const [responsibles, documents, majorityAge, location] =
        await Promise.all([
          loadNoticeResponsibles(tx, patientId),
          tx.patientResponsibleParty.findMany({
            where: { patientId, deletedAt: null },
            select: {
              id: true,
              documentType: true,
              docTypeLabel: true,
              docNumber: true,
              responsiblePatient: {
                select: {
                  documentType: true,
                  docTypeLabel: true,
                  docNumber: true,
                },
              },
            },
          }),
          loadTenantMajorityAge(tx, tenantId),
          resolveReferenceLocation(
            tx,
            tenantId,
            this.tenantContext.getLocationId() ?? null,
          ),
        ]);
      const docById = new Map(
        documents.map((d) => {
          const source = d.responsiblePatient ?? d;
          return [
            d.id,
            {
              docType: source.documentType,
              docTypeLabel: source.docTypeLabel,
              docNumber: source.docNumber,
            },
          ];
        }),
      );
      return {
        patient,
        responsibles: responsibles.map((r) => ({
          ...r,
          document: docById.get(r.id) ?? {
            docType: null,
            docTypeLabel: null,
            docNumber: null,
          },
        })),
        majorityAge,
        timeZone: location.timeZone,
      };
    });
  }

  async findProfessional(
    userId: string,
  ): Promise<SignatureProfessional | null> {
    const tenantId = this.requireTenantId();
    const membership = await this.prisma.runWithTenant((tx) =>
      tx.clinicMembership.findFirst({
        where: {
          tenantId,
          userId,
          deletedAt: null,
          role: { in: PROFESSIONAL_ROLES },
          user: { deletedAt: null },
        },
        select: PROFESSIONAL_SELECT,
      }),
    );
    return membership ? { ...membership.user, role: membership.role } : null;
  }

  async listProfessionals(): Promise<SignatureProfessional[]> {
    const tenantId = this.requireTenantId();
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.clinicMembership.findMany({
        where: {
          tenantId,
          deletedAt: null,
          role: { in: PROFESSIONAL_ROLES },
          user: { deletedAt: null },
        },
        orderBy: [{ user: { fullName: 'asc' } }, { userId: 'asc' }],
        select: PROFESSIONAL_SELECT,
      }),
    );
    return rows.map((r) => ({ ...r.user, role: r.role }));
  }

  listPlans(patientId: string): Promise<SignaturePlanOption[]> {
    return this.prisma.runWithTenant((tx) =>
      tx.treatmentPlan.findMany({
        where: {
          patientId,
          deletedAt: null,
          status: { not: TreatmentPlanStatus.CANCELLED },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: { id: true, status: true, optionLabel: true, createdAt: true },
      }),
    );
  }

  listCompletedConsents(
    patientId: string,
  ): Promise<{ templateId: string; signedAt: Date }[]> {
    // Completo = firmado en la clínica (lleva la firma del profesional) o a
    // distancia con la firma del profesional después.
    return this.prisma.runWithTenant((tx) =>
      tx.patientConsent.findMany({
        where: {
          patientId,
          OR: [
            { professionalSignature: { not: null } },
            { countersignature: { isNot: null } },
          ],
        },
        select: { templateId: true, signedAt: true },
      }),
    );
  }

  create(
    input: CreateSignatureRequestRepoInput,
  ): Promise<{ id: string; supersededIds: string[] }> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // La anterior del mismo paciente y plantilla que aún esperaba deja de
      // servir: un solo enlace vivo por documento.
      const pending = await tx.signatureRequest.findMany({
        where: {
          patientId: input.patientId,
          templateId: input.templateId,
          signedAt: null,
          revokedAt: null,
        },
        select: { id: true },
      });
      const supersededIds = pending.map((p) => p.id);
      if (supersededIds.length > 0) {
        await tx.signatureRequest.updateMany({
          where: { id: { in: supersededIds }, signedAt: null, revokedAt: null },
          data: { revokedAt: input.createdAt, revokedById: input.createdById },
        });
      }
      const created = await tx.signatureRequest.create({
        data: { tenantId, ...input },
        select: { id: true },
      });
      return { id: created.id, supersededIds };
    });
  }

  async listByPatient(
    patientId: string,
    limit: number,
  ): Promise<SignatureRequestListRow[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.signatureRequest.findMany({
        where: { patientId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        include: LIST_INCLUDE,
      }),
    );
    return rows.map(toListRow);
  }

  async findById(id: string): Promise<SignatureRequestListRow | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.signatureRequest.findFirst({ where: { id }, include: LIST_INCLUDE }),
    );
    return row ? toListRow(row) : null;
  }

  revoke(input: {
    id: string;
    revokedById: string;
    now: Date;
  }): Promise<RevokeOutcome> {
    return this.prisma.runWithTenant(async (tx) => {
      const { count } = await tx.signatureRequest.updateMany({
        where: { id: input.id, signedAt: null, revokedAt: null },
        data: {
          revokedAt: input.now,
          revokedById: input.revokedById,
          sessionHash: null,
          sessionExpiresAt: null,
          codeHash: null,
          codeExpiresAt: null,
        },
      });
      if (count > 0) return 'REVOKED';
      const exists = await tx.signatureRequest.findFirst({
        where: { id: input.id },
        select: { id: true },
      });
      return exists ? 'NOT_PENDING' : 'NOT_FOUND';
    });
  }

  async findByTokenHash(
    tokenHash: string,
  ): Promise<PublicSignatureContext | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.signatureRequest.findFirst({
        where: { tokenHash },
        include: {
          location: {
            select: { id: true, timeZone: true, locale: true, hourCycle: true },
          },
        },
      });
      if (!row) return null;
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true, logoUrl: true, primaryColor: true },
      });
      const { location, ...request } = row;
      return {
        request: toRecord(request),
        clinic: tenant,
        location: {
          timeZone: requireLocationTimeZone(location),
          locale: location.locale,
          hourCycle: location.hourCycle,
        },
      };
    });
  }

  withLockedRequest<T>(
    id: string,
    evidence: PublicRequestEvidence,
    decide: (request: SignatureRequestRecord) => {
      write: LockedWrite | null;
      result: T;
    },
  ): Promise<T | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Serializa los pasos sobre un mismo enlace (códigos a la vez, doble
      // firma): el siguiente espera aquí y decide con lo ya confirmado.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "signature_requests" WHERE "id" = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) return null;
      const row = await tx.signatureRequest.findUniqueOrThrow({
        where: { id },
      });
      const request = toRecord(row);
      const { write, result } = decide(request);
      if (!write) return result;

      await tx.signatureRequest.update({ where: { id }, data: write.patch });
      if (write.consent) {
        await tx.patientConsent.create({
          data: {
            tenantId,
            patientId: request.patientId,
            signatureRequestId: request.id,
            ...write.consent,
          },
        });
      }
      for (const event of write.audit) {
        // Sin código, token ni texto: quién (el paciente), qué solicitud, por
        // dónde (LINK) y el paso.
        await writeAuditEvent(tx, {
          tenantId,
          locationId: request.locationId,
          actor: { kind: 'patient' },
          action: event.action,
          resourceType: 'SIGNATURE_REQUEST',
          resourceId: request.id,
          patient: { kind: 'patient', id: request.patientId },
          requestId: evidence.requestId,
          ip: evidence.ipAddress,
          userAgent: evidence.userAgent,
          metadata: { origin: 'LINK', reason: event.reason },
        });
      }
      return result;
    });
  }
}
