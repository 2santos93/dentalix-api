import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveReferenceLocation } from '../../../../shared/locations/reference-location';
import {
  PatientConsent,
  StoredPatientConsentDocument,
  PatientConsentSummary,
} from '../../domain/entities/patient-consent.entity';
import {
  AlreadyCountersignedError,
  ConsentSigningContext,
  CountersignTarget,
  CreateCountersignatureRepoInput,
  CreatePatientConsentRepoInput,
  PatientConsentRepository,
} from '../../domain/ports/patient-consent-repository.port';

/** Columnas del listado: todo menos el texto, las firmas, IP y UA. */
const SUMMARY_SELECT = {
  id: true,
  tenantId: true,
  patientId: true,
  templateId: true,
  templateVersion: true,
  treatmentPlanId: true,
  title: true,
  signerType: true,
  signerName: true,
  signerDocument: true,
  professionalName: true,
  contentHash: true,
  signedAt: true,
  recordedById: true,
  ...REMOTE_SELECT_FIELDS(),
} satisfies Prisma.PatientConsentSelect;

/**
 * DX-243: lo que dice si es a distancia y si ya firmó el profesional: las
 * evidencias congeladas, quién debe firmar (de la solicitud) y la hora de su
 * firma. Sin la firma del profesional en sí (pesa).
 */
function REMOTE_SELECT_FIELDS() {
  return {
    signatureRequestId: true,
    remoteChannel: true,
    remoteDestinationMasked: true,
    remoteSentAt: true,
    remoteOpenedAt: true,
    remoteVerifiedAt: true,
    signatureRequest: { select: { professionalUserId: true } },
    countersignature: { select: { signedAt: true } },
  } as const;
}

type RemoteFields = Prisma.PatientConsentGetPayload<{
  select: ReturnType<typeof REMOTE_SELECT_FIELDS>;
}> & { signedAt: Date };

/** Evidencias, hora de la firma del profesional y si está completo. */
function remoteOf(
  row: RemoteFields,
): Pick<PatientConsentSummary, 'remote' | 'professionalSignedAt' | 'complete'> {
  if (
    !row.signatureRequestId ||
    !row.remoteChannel ||
    !row.remoteDestinationMasked ||
    !row.remoteSentAt ||
    !row.remoteOpenedAt ||
    !row.remoteVerifiedAt ||
    !row.signatureRequest
  ) {
    // Firmado en pantalla: las dos firmas a la vez (el CHECK lo garantiza).
    return { remote: null, professionalSignedAt: row.signedAt, complete: true };
  }
  const countersignedAt = row.countersignature?.signedAt ?? null;
  return {
    remote: {
      signatureRequestId: row.signatureRequestId,
      channel: row.remoteChannel,
      destinationMasked: row.remoteDestinationMasked,
      sentAt: row.remoteSentAt,
      openedAt: row.remoteOpenedAt,
      verifiedAt: row.remoteVerifiedAt,
      professionalUserId: row.signatureRequest.professionalUserId,
    },
    professionalSignedAt: countersignedAt,
    complete: countersignedAt !== null,
  };
}

const FULL_INCLUDE = {
  signatureRequest: { select: { professionalUserId: true } },
  countersignature: {
    select: {
      signedAt: true,
      professionalName: true,
      professionalSignature: true,
      contentHash: true,
    },
  },
} as const;

type PrismaPatientConsent = Prisma.PatientConsentGetPayload<{
  include: typeof FULL_INCLUDE;
}>;

function toSummary(
  row: Prisma.PatientConsentGetPayload<{ select: typeof SUMMARY_SELECT }>,
): PatientConsentSummary {
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    treatmentPlanId: row.treatmentPlanId,
    title: row.title,
    signerType: row.signerType,
    signerName: row.signerName,
    signerDocument: row.signerDocument,
    professionalName: row.professionalName,
    contentHash: row.contentHash,
    signedAt: row.signedAt,
    recordedById: row.recordedById,
    ...remoteOf(row),
  };
}

function mapToEntity(row: PrismaPatientConsent): PatientConsent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    treatmentPlanId: row.treatmentPlanId,
    title: row.title,
    body: row.body,
    signerType: row.signerType,
    signerName: row.signerName,
    signerDocument: row.signerDocument,
    professionalName: row.professionalName,
    patientSignature: row.patientSignature,
    // A distancia, la firma del profesional vive en su propia tabla.
    professionalSignature:
      row.professionalSignature ??
      row.countersignature?.professionalSignature ??
      null,
    contentHash: row.contentHash,
    signedAt: row.signedAt,
    recordedById: row.recordedById,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    ...remoteOf(row),
  };
}

const UNKNOWN_PROFESSIONAL = 'Profesional';

@Injectable()
export class PrismaPatientConsentRepository implements PatientConsentRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  /**
   * Todo bajo `runWithTenant` (RLS): un paciente o un plan de otra clínica no
   * se ven y salen como "no encontrado". El plan se busca además por
   * `patientId`: un plan de OTRO paciente de la misma clínica tampoco vale.
   * `tenants` y `users` no tienen RLS (tablas globales): se acotan por el
   * tenant del contexto y por el usuario del token.
   */
  async loadSigningContext(params: {
    patientId: string;
    treatmentPlanId?: string;
    professionalUserId: string;
  }): Promise<ConsentSigningContext | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(
      async (tx) => {
        const patient = await tx.patient.findFirst({
          where: { id: params.patientId, deletedAt: null },
          select: {
            firstName: true,
            lastName: true,
            documentType: true,
            docTypeLabel: true,
            docNumber: true,
          },
        });
        if (!patient) return null;

        const [tenant, user, location] = await Promise.all([
          tx.tenant.findFirst({
            where: { id: tenantId, deletedAt: null },
            select: { name: true },
          }),
          tx.user.findFirst({
            where: { id: params.professionalUserId },
            select: { fullName: true },
          }),
          resolveReferenceLocation(
            tx,
            tenantId,
            this.tenantContext.getLocationId() ?? null,
          ),
        ]);

        let plan: ConsentSigningContext['plan'];
        if (params.treatmentPlanId !== undefined) {
          const found = await tx.treatmentPlan.findFirst({
            where: {
              id: params.treatmentPlanId,
              patientId: params.patientId,
              deletedAt: null,
            },
            select: {
              id: true,
              items: {
                where: { deletedAt: null },
                orderBy: { createdAt: 'asc' },
                select: { toothNumber: true, catalogItemId: true },
              },
            },
          });
          if (!found) {
            plan = null;
          } else {
            const catalog = await tx.dentalCatalogItem.findMany({
              where: { id: { in: found.items.map((i) => i.catalogItemId) } },
              select: { id: true, labelEs: true },
            });
            const labels = new Map(catalog.map((c) => [c.id, c.labelEs]));
            plan = {
              id: found.id,
              items: found.items.map((item) => ({
                label: labels.get(item.catalogItemId) ?? 'Procedimiento',
                toothNumber: item.toothNumber,
              })),
            };
          }
        }

        const { documentType, ...rest } = patient;
        return {
          patient: { ...rest, docType: documentType },
          clinicName: tenant?.name ?? '',
          professionalName: user?.fullName ?? UNKNOWN_PROFESSIONAL,
          timeZone: location.timeZone,
          location: {
            id: location.id,
            locale: location.locale,
            hourCycle: location.hourCycle,
          },
          plan,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async create(input: CreatePatientConsentRepoInput): Promise<PatientConsent> {
    const tenantId = this.requireTenantId();
    // Append-only: un INSERT. Este repositorio no tiene update ni delete, y un
    // trigger de la base rechaza ambos (20261016180000_patient_consents).
    const row = await this.prisma.runWithTenant((tx) =>
      tx.patientConsent.create({
        data: { tenantId, ...input },
        include: FULL_INCLUDE,
      }),
    );
    return mapToEntity(row);
  }

  async listByPatient(patientId: string): Promise<PatientConsentSummary[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.patientConsent.findMany({
        where: { patientId },
        orderBy: [{ signedAt: 'desc' }, { id: 'desc' }],
        select: SUMMARY_SELECT,
      }),
    );
    return rows.map(toSummary);
  }

  async findCountersignTarget(
    patientId: string,
    id: string,
  ): Promise<CountersignTarget | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.patientConsent.findFirst({
        where: { id, patientId },
        select: {
          id: true,
          patientId: true,
          contentHash: true,
          signatureRequest: {
            select: { professionalUserId: true, professionalName: true },
          },
          countersignature: { select: { id: true } },
        },
      }),
    );
    if (!row) return null;
    return {
      id: row.id,
      patientId: row.patientId,
      contentHash: row.contentHash,
      remote: row.signatureRequest,
      countersigned: row.countersignature !== null,
    };
  }

  async countersign(
    input: CreateCountersignatureRepoInput,
    onCompleted?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<PatientConsentSummary> {
    const tenantId = this.requireTenantId();
    try {
      // Un INSERT: la tabla es append-only y su trigger exige que el
      // consentimiento sea a distancia y no tenga ya la firma.
      const row = await this.prisma.runWithTenant(async (tx) => {
        await tx.patientConsentCountersignature.create({
          data: { tenantId, ...input },
        });
        // DX-422: el estado del PDF firmado nace PENDING con la firma que
        // lo completa, y su trabajo se encola en la misma transacción.
        await tx.signedConsentPdf.create({
          data: {
            tenantId,
            patientId: input.patientId,
            consentId: input.consentId,
          },
        });
        await onCompleted?.(tx);
        return tx.patientConsent.findFirstOrThrow({
          where: { id: input.consentId, patientId: input.patientId },
          select: SUMMARY_SELECT,
        });
      });
      return toSummary(row);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AlreadyCountersignedError();
      }
      throw error;
    }
  }

  async findDocument(
    patientId: string,
    id: string,
  ): Promise<StoredPatientConsentDocument | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.patientConsent.findFirst({
        where: { id, patientId },
        include: {
          ...FULL_INCLUDE,
          patient: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              documentType: true,
              docTypeLabel: true,
              docNumber: true,
            },
          },
        },
      });
      if (!row) return null;
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId },
        select: { name: true, logoUrl: true },
      });
      const {
        patient: { documentType, ...patient },
        ...consent
      } = row;
      return {
        ...mapToEntity(consent),
        clinic: { name: tenant?.name ?? '', logoUrl: tenant?.logoUrl ?? null },
        patient: { ...patient, docType: documentType },
        countersignature: consent.countersignature,
      };
    });
  }
}
