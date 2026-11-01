import {
  CLINIC_FISCAL_SELECT,
  clinicFiscalOf,
} from '../../../../shared/clinic/clinic-fiscal';
import { Injectable } from '@nestjs/common';
import { Prisma, type SignatureRequestChannel } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import type {
  AcceptPlanOutcome,
  PlanAcceptanceRemoteEvidence,
  NewPlanAcceptance,
  PlanQuoteRepository,
  PlanQuoteSource,
} from '../../domain/ports/plan-quote-repository.port';
import { acceptPlanInTx, lockPlanGroup } from './plan-option-group';

const PROCEDURE_FALLBACK = 'Procedimiento';
const UNKNOWN_PROFESSIONAL = 'Profesional';

class AlreadyAccepted extends Error {}

/**
 * Presupuesto y aceptación firmada (DX-012). Todo bajo `runWithTenant` (RLS):
 * un paciente, un plan o una sede de otra clínica no existen para esta. El
 * plan se busca además por `patientId`: el de otro paciente de la misma
 * clínica tampoco vale. `tenants` y `users` no tienen RLS (tablas globales):
 * se acotan por el tenant del contexto y por ids que salen de filas ya
 * filtradas.
 */
@Injectable()
export class PrismaPlanQuoteRepository implements PlanQuoteRepository {
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

  loadSource(
    patientId: string,
    planId: string,
  ): Promise<PlanQuoteSource | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(
      async (tx) =>
        readPlanQuoteSource(
          tx,
          tenantId,
          patientId,
          planId,
          // DX-089: la sede del request o la de escritura de la sesión.
          await this.tenantContext.writeLocationId(tx),
        ),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async accept(
    patientId: string,
    planId: string,
    decide: (source: PlanQuoteSource) => NewPlanAcceptance,
  ): Promise<AcceptPlanOutcome> {
    const tenantId = this.requireTenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        // El plan tiene que ser de ESTE paciente; si no, 404 sin bloquear.
        const owned = await tx.treatmentPlan.findFirst({
          where: { id: planId, patientId, deletedAt: null },
          select: { id: true },
        });
        if (!owned) return { kind: 'NOT_FOUND' } as const;
        // FOR UPDATE del plan y de las demás opciones de su grupo, en orden de
        // id (DX-040): una segunda firma concurrente espera aquí y luego ve la
        // aceptación; la aceptación de una hermana espera y luego ve este plan
        // ya rechazado; un cambio de ítems concurrente espera en su trigger
        // (FOR SHARE del plan) y luego choca con ella.
        const locked = await lockPlanGroup(tx, planId);
        if (!locked) return { kind: 'NOT_FOUND' } as const;
        const locationId = await this.tenantContext.writeLocationId(tx);
        const source = await readPlanQuoteSource(
          tx,
          tenantId,
          patientId,
          planId,
          locationId,
        );
        if (!source) return { kind: 'NOT_FOUND' } as const;

        const row = decide(source);
        try {
          await tx.treatmentPlanAcceptance.create({
            data: {
              tenantId,
              planId,
              patientId,
              locationId: row.locationId,
              signerName: row.signerName,
              signature: row.signature,
              content: row.content,
              contentHash: row.contentHash,
              acceptanceHash: row.acceptanceHash,
              acceptedAt: row.acceptedAt,
              acceptedById: row.acceptedById,
              ipAddress: row.ipAddress,
              userAgent: row.userAgent,
            },
          });
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            throw new AlreadyAccepted();
          }
          throw error;
        }
        // Misma aceptación que el PATCH (DX-109): hermanas rechazadas, plan
        // ACCEPTED e ítems PROPOSED → ACCEPTED, en esta transacción.
        await acceptPlanInTx(
          tx,
          locked,
          row.acceptedAt,
          row.acceptedById,
          row.locationId,
        );

        const accepted = await readPlanQuoteSource(
          tx,
          tenantId,
          patientId,
          planId,
          locationId,
        );
        if (!accepted) return { kind: 'NOT_FOUND' } as const;
        return { kind: 'ACCEPTED', source: accepted } as const;
      });
    } catch (error) {
      if (error instanceof AlreadyAccepted) return { kind: 'ALREADY_ACCEPTED' };
      throw error;
    }
  }
}

/**
 * El presupuesto del plan `planId` del paciente `patientId` emitido en la sede
 * `locationId`, dentro de la transacción del llamador (bajo la RLS de la
 * clínica). DX-415 lo usa con la sede de la solicitud a distancia, que no
 * viene de ninguna cabecera.
 */
export async function readPlanQuoteSource(
  tx: Prisma.TransactionClient,
  tenantId: string,
  patientId: string,
  planId: string,
  locationId: string,
): Promise<PlanQuoteSource | null> {
  const plan = await tx.treatmentPlan.findFirst({
    where: { id: planId, patientId, deletedAt: null },
    select: {
      id: true,
      patientId: true,
      status: true,
      currency: true,
      visitIntervals: true,
      createdById: true,
      patient: {
        select: {
          firstName: true,
          lastName: true,
          documentType: true,
          docTypeLabel: true,
          docNumber: true,
          deletedAt: true,
        },
      },
      items: {
        where: { deletedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          visit: true,
          visitLabel: true,
          toothNumber: true,
          surfaces: true,
          catalogItemId: true,
          price: true,
          discount: true,
          basePrice: true,
          catalogPrice: true,
          agreementId: true,
          agreementName: true,
        },
      },
      acceptance: {
        select: {
          content: true,
          contentHash: true,
          signerName: true,
          signature: true,
          acceptedAt: true,
          acceptanceHash: true,
          acceptedBy: { select: { fullName: true } },
          ipAddress: true,
          userAgent: true,
          signatureRequestId: true,
          remoteChannel: true,
          remoteDestinationMasked: true,
          remoteSentAt: true,
          remoteOpenedAt: true,
          remoteVerifiedAt: true,
        },
      },
    },
  });
  if (!plan || plan.patient.deletedAt !== null) return null;

  const [location, tenant, professional, catalog, zoneOf] = await Promise.all([
    tx.location.findFirstOrThrow({
      where: { id: locationId, deletedAt: null },
      select: { id: true, name: true, address: true },
    }),
    tx.tenant.findFirst({
      where: { id: tenantId },
      select: { name: true, logoUrl: true, ...CLINIC_FISCAL_SELECT },
    }),
    plan.createdById
      ? tx.user.findFirst({
          where: { id: plan.createdById },
          select: { fullName: true },
        })
      : Promise.resolve(null),
    tx.dentalCatalogItem.findMany({
      where: { id: { in: plan.items.map((i) => i.catalogItemId) } },
      select: { id: true, labelEs: true },
    }),
    resolveLocationTimeZones(tx, tenantId, [locationId]),
  ]);
  const labels = new Map(catalog.map((c) => [c.id, c.labelEs]));
  // DX-105: el pagador de cada convenio, una consulta por los ids distintos
  // (no una por ítem). El nombre del convenio es el de la foto del ítem; el
  // pagador se lee vivo porque la foto no lo guarda.
  const agreementIds = [
    ...new Set(
      plan.items.flatMap((i) => (i.agreementId ? [i.agreementId] : [])),
    ),
  ];
  const agreements =
    agreementIds.length === 0
      ? []
      : await tx.agreement.findMany({
          where: { id: { in: agreementIds } },
          select: { id: true, payer: { select: { name: true } } },
        });
  const payerNames = new Map(agreements.map((a) => [a.id, a.payer.name]));
  const { patient, acceptance } = plan;

  return {
    visitOrganization: plan.items.map((i) => ({
      itemId: i.id,
      visit: i.visit,
      label: i.visitLabel,
      minDaysAfterPrevious:
        (plan.visitIntervals as Record<string, number>)[String(i.visit)] ?? 0,
    })),
    plan: {
      id: plan.id,
      patientId: plan.patientId,
      status: plan.status,
      currency: plan.currency,
    },
    items: plan.items.map((item) => ({
      id: item.id,
      toothNumber: item.toothNumber,
      surfaces: [...item.surfaces],
      procedure: labels.get(item.catalogItemId) ?? PROCEDURE_FALLBACK,
      price: item.price.toNumber(),
      discount: item.discount.toNumber(),
      basePrice: item.basePrice?.toNumber() ?? null,
      referencePrice: item.catalogPrice?.toNumber() ?? null,
      agreementName: item.agreementName,
      agreementPayerName: item.agreementId
        ? requirePayerName(payerNames, item.agreementId, plan.id)
        : null,
    })),
    patient: {
      firstName: patient.firstName,
      lastName: patient.lastName,
      docType: patient.documentType,
      docTypeLabel: patient.docTypeLabel,
      docNumber: patient.docNumber,
    },
    clinic: {
      name: tenant?.name ?? '',
      logoUrl: tenant?.logoUrl ?? null,
      fiscal: clinicFiscalOf(tenant),
    },
    location: { ...location, timeZone: zoneOf(location.id) },
    professionalName: plan.createdById
      ? (professional?.fullName ?? UNKNOWN_PROFESSIONAL)
      : null,
    acceptance: acceptance
      ? {
          content: acceptance.content,
          contentHash: acceptance.contentHash,
          signerName: acceptance.signerName,
          signature: acceptance.signature,
          acceptedAt: acceptance.acceptedAt,
          acceptedByName: acceptance.acceptedBy.fullName,
          acceptanceHash: acceptance.acceptanceHash,
          ipAddress: acceptance.ipAddress,
          userAgent: acceptance.userAgent,
          remote: remoteEvidenceOf(acceptance),
        }
      : null,
  };
}

function remoteEvidenceOf(acceptance: {
  signatureRequestId: string | null;
  remoteChannel: SignatureRequestChannel | null;
  remoteDestinationMasked: string | null;
  remoteSentAt: Date | null;
  remoteOpenedAt: Date | null;
  remoteVerifiedAt: Date | null;
}): PlanAcceptanceRemoteEvidence | null {
  // Todas o ninguna (CHECK treatment_plan_acceptances_remote_check).
  if (
    !acceptance.signatureRequestId ||
    !acceptance.remoteChannel ||
    !acceptance.remoteDestinationMasked ||
    !acceptance.remoteSentAt ||
    !acceptance.remoteOpenedAt ||
    !acceptance.remoteVerifiedAt
  ) {
    return null;
  }
  return {
    signatureRequestId: acceptance.signatureRequestId,
    channel: acceptance.remoteChannel,
    destinationMasked: acceptance.remoteDestinationMasked,
    sentAt: acceptance.remoteSentAt,
    openedAt: acceptance.remoteOpenedAt,
    verifiedAt: acceptance.remoteVerifiedAt,
  };
}

/**
 * El pagador del convenio de un ítem tiene que existir: sellar un presupuesto
 * con el pagador en blanco lo dejaría firmado sin remedio, así que se falla
 * (500 con mensaje interno claro) antes de sellar.
 */
function requirePayerName(
  payerNames: Map<string, string>,
  agreementId: string,
  planId: string,
): string {
  const name = payerNames.get(agreementId);
  if (!name) {
    throw new Error(
      `Plan ${planId}: el convenio ${agreementId} de un ítem no tiene pagador; no se puede sellar el presupuesto.`,
    );
  }
  return name;
}
