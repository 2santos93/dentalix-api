import { Injectable } from '@nestjs/common';
import {
  ClinicRole,
  Prisma,
  SignatureRequestType,
  TreatmentPlanStatus,
} from '@prisma/client';
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { resolveReferenceLocation } from '../../../shared/locations/reference-location';
import { requireLocationTimeZone } from '../../../shared/locations/location-time-zone';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import {
  acceptPlanInTx,
  lockPlanGroup,
} from '../../treatment-plans/infrastructure/repositories/plan-option-group';
import { readPlanQuoteSource } from '../../treatment-plans/infrastructure/repositories/prisma-plan-quote.repository';
import {
  loadNoticeResponsibles,
  loadTenantMajorityAge,
} from '../../patients/infrastructure/notices/notice-context';
import type {
  PublicSignatureContext,
  SignatureRequestListRow,
  SignatureRequestRecord,
} from '../domain/entities/signature-request.entity';
import {
  RemoteBudgetChangedError,
  type BudgetSource,
  type CreateSignatureRequestRepoInput,
  type LockedWrite,
  type PublicRequestEvidence,
  type RemoteBudgetAcceptanceInsert,
  type RevokeOutcome,
  type SignaturePlanOption,
  type SignatureProfessional,
  type SignatureRecipientContext,
  type SignatureRequestRepository,
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
      signedPdf: {
        select: {
          status: true,
          documentId: true,
          // DX-443: el último envío de la copia (signed_consent_pdf_links_sent_idx).
          links: {
            select: { createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  },
  budgetAcceptance: { select: { id: true, ipAddress: true } },
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
    budgetContent: row.budgetContent,
    budgetContentHash: row.budgetContentHash,
  };
}

function toListRow(row: ListRow): SignatureRequestListRow {
  const { createdBy, consent, budgetAcceptance, ...request } = row;
  return {
    request: toRecord(request),
    sentByName: createdBy.fullName,
    consent: consent
      ? {
          id: consent.id,
          ipAddress: consent.ipAddress,
          countersignedAt: consent.countersignature?.signedAt ?? null,
          signedPdf: consent.signedPdf
            ? {
                status: consent.signedPdf.status,
                documentId: consent.signedPdf.documentId,
                copySentAt: consent.signedPdf.links[0]?.createdAt ?? null,
              }
            : null,
        }
      : null,
    budgetAcceptance,
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
      // La anterior del mismo paciente y plantilla (o, BUDGET, del mismo
      // plan) que aún esperaba deja de servir: un solo enlace vivo por
      // documento.
      const pending = await tx.signatureRequest.findMany({
        where: {
          patientId: input.patientId,
          type: input.type,
          ...(input.type === SignatureRequestType.BUDGET
            ? { treatmentPlanId: input.treatmentPlanId }
            : { templateId: input.templateId }),
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

  async loadBudget(
    patientId: string,
    planId: string,
    locationId?: string,
  ): Promise<BudgetSource | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(
      async (tx) => {
        const at = locationId ?? (await this.tenantContext.writeLocationId(tx));
        const [quote, location] = await Promise.all([
          readPlanQuoteSource(tx, tenantId, patientId, planId, at),
          tx.location.findFirst({
            where: { id: at },
            select: { id: true, locale: true, hourCycle: true },
          }),
        ]);
        return quote && location ? { quote, location } : null;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async findByTokenHash(
    tokenHash: string,
  ): Promise<PublicSignatureContext | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.signatureRequest.findFirst({
        // DX-461: el enlace de un paciente archivado no existe para la ruta
        // pública («Enlace no válido», igual que caducado o anulado).
        where: { tokenHash, patient: { deletedAt: null } },
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
      // DX-461: primero el paciente vivo (FOR KEY SHARE), en el orden de
      // archivar (paciente → solicitudes). Si no, firmar bloquea la solicitud,
      // archivar bloquea al paciente y espera la solicitud, y el INSERT del
      // consentimiento (FK al paciente) espera a archivar: deadlock. Así la
      // firma espera al COMMIT de archivar y ve al paciente archivado (null =
      // enlace no válido); también cubre un archivado anterior a DX-461.
      const live = await tx.$queryRaw<{ id: string }[]>`
        SELECT p."id" FROM "patients" p
         WHERE p."id" = (SELECT sr."patientId" FROM "signature_requests" sr
                          WHERE sr."id" = ${id}::uuid)
           AND p."deletedAt" IS NULL
         FOR KEY SHARE`;
      if (live.length === 0) return null;
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "signature_requests" WHERE "id" = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) return null;
      const row = await tx.signatureRequest.findUniqueOrThrow({
        where: { id },
      });
      const request = toRecord(row);
      const { write, result } = decide(request);
      if (!write) return result;

      if (write.budget) {
        await this.acceptBudget(tx, tenantId, request, write.budget);
      }
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

  /**
   * DX-415: la misma aceptación que la firma en la clínica (DX-012/DX-040),
   * con el plan y su grupo bloqueados en orden de id: se relee el presupuesto
   * y, si sigue siendo el enviado, se inserta la aceptación con sus
   * evidencias y `acceptPlanInTx` pasa el plan a ACCEPTED, sus ítems a
   * aceptados y rechaza las demás opciones abiertas del grupo. Si no, se
   * deshace todo (`RemoteBudgetChangedError`).
   */
  private async acceptBudget(
    tx: Prisma.TransactionClient,
    tenantId: string,
    request: SignatureRequestRecord,
    budget: RemoteBudgetAcceptanceInsert,
  ): Promise<void> {
    const locked = await lockPlanGroup(tx, budget.planId);
    if (!locked) throw new RemoteBudgetChangedError();
    const source = await readPlanQuoteSource(
      tx,
      tenantId,
      request.patientId,
      budget.planId,
      budget.locationId,
    );
    if (!source || !budget.stillMatches(source)) {
      throw new RemoteBudgetChangedError();
    }
    const { planId, locationId } = budget;
    try {
      await tx.treatmentPlanAcceptance.create({
        data: {
          tenantId,
          planId,
          patientId: request.patientId,
          locationId,
          signatureRequestId: request.id,
          signerName: budget.signerName,
          signature: budget.signature,
          content: budget.content,
          contentHash: budget.contentHash,
          acceptanceHash: budget.acceptanceHash,
          acceptedAt: budget.acceptedAt,
          acceptedById: budget.acceptedById,
          ipAddress: budget.ipAddress,
          userAgent: budget.userAgent,
          remoteChannel: budget.remoteChannel,
          remoteDestinationMasked: budget.remoteDestinationMasked,
          remoteSentAt: budget.remoteSentAt,
          remoteOpenedAt: budget.remoteOpenedAt,
          remoteVerifiedAt: budget.remoteVerifiedAt,
        },
      });
    } catch (error) {
      // Otra firma (en la clínica o por otro enlace) llegó antes.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new RemoteBudgetChangedError();
      }
      throw error;
    }
    await acceptPlanInTx(
      tx,
      locked,
      budget.acceptedAt,
      budget.acceptedById,
      locationId,
    );
  }
}
