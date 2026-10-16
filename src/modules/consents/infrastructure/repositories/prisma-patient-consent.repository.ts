import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  PatientConsent,
  PatientConsentDocument,
  PatientConsentSummary,
} from '../../domain/entities/patient-consent.entity';
import {
  ConsentSigningContext,
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
} satisfies Prisma.PatientConsentSelect;

type PrismaPatientConsent = Prisma.PatientConsentGetPayload<
  Record<string, never>
>;

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
    professionalSignature: row.professionalSignature,
    contentHash: row.contentHash,
    signedAt: row.signedAt,
    recordedById: row.recordedById,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
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
            docType: true,
            docNumber: true,
          },
        });
        if (!patient) return null;

        const [tenant, user] = await Promise.all([
          tx.tenant.findFirst({
            where: { id: tenantId, deletedAt: null },
            select: { name: true },
          }),
          tx.user.findFirst({
            where: { id: params.professionalUserId },
            select: { fullName: true },
          }),
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

        return {
          patient,
          clinicName: tenant?.name ?? '',
          professionalName: user?.fullName ?? UNKNOWN_PROFESSIONAL,
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
      tx.patientConsent.create({ data: { tenantId, ...input } }),
    );
    return mapToEntity(row);
  }

  listByPatient(patientId: string): Promise<PatientConsentSummary[]> {
    return this.prisma.runWithTenant((tx) =>
      tx.patientConsent.findMany({
        where: { patientId },
        orderBy: [{ signedAt: 'desc' }, { id: 'desc' }],
        select: SUMMARY_SELECT,
      }),
    );
  }

  async findDocument(
    patientId: string,
    id: string,
  ): Promise<Omit<PatientConsentDocument, 'integrityOk'> | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.patientConsent.findFirst({
        where: { id, patientId },
        include: {
          patient: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              docType: true,
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
      const { patient, ...consent } = row;
      return {
        ...mapToEntity(consent),
        clinic: { name: tenant?.name ?? '', logoUrl: tenant?.logoUrl ?? null },
        patient,
      };
    });
  }
}
