import { Injectable } from '@nestjs/common';
import {
  Prisma,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveDefaultLocationId } from '../../../../shared/locations/default-location';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import type {
  AcceptPlanOutcome,
  NewPlanAcceptance,
  PlanQuoteRepository,
  PlanQuoteSource,
} from '../../domain/ports/plan-quote-repository.port';
import { lockPlanGroup, rejectOpenSiblings } from './plan-option-group';

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
      (tx) => this.readSource(tx, tenantId, patientId, planId),
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
        const source = await this.readSource(tx, tenantId, patientId, planId);
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
        // Las demás opciones abiertas del grupo, rechazadas en esta misma
        // transacción (DX-040).
        await rejectOpenSiblings(tx, locked, row.acceptedAt);
        await tx.treatmentPlan.update({
          where: { id: planId },
          data: { status: TreatmentPlanStatus.ACCEPTED },
        });
        await tx.treatmentPlanItem.updateMany({
          where: {
            planId,
            deletedAt: null,
            status: TreatmentPlanItemStatus.PROPOSED,
          },
          data: { status: TreatmentPlanItemStatus.ACCEPTED },
        });

        const accepted = await this.readSource(tx, tenantId, patientId, planId);
        if (!accepted) return { kind: 'NOT_FOUND' } as const;
        return { kind: 'ACCEPTED', source: accepted } as const;
      });
    } catch (error) {
      if (error instanceof AlreadyAccepted) return { kind: 'ALREADY_ACCEPTED' };
      throw error;
    }
  }

  private async readSource(
    tx: Prisma.TransactionClient,
    tenantId: string,
    patientId: string,
    planId: string,
  ): Promise<PlanQuoteSource | null> {
    const plan = await tx.treatmentPlan.findFirst({
      where: { id: planId, patientId, deletedAt: null },
      select: {
        id: true,
        patientId: true,
        status: true,
        currency: true,
        createdById: true,
        patient: {
          select: {
            firstName: true,
            lastName: true,
            docType: true,
            docNumber: true,
            deletedAt: true,
          },
        },
        items: {
          where: { deletedAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            toothNumber: true,
            surfaces: true,
            catalogItemId: true,
            price: true,
            discount: true,
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
          },
        },
      },
    });
    if (!plan || plan.patient.deletedAt !== null) return null;

    const locationId =
      this.tenantContext.getLocationId() ??
      (await resolveDefaultLocationId(tx));
    const [location, tenant, professional, catalog, zoneOf] = await Promise.all(
      [
        tx.location.findFirstOrThrow({
          where: { id: locationId, deletedAt: null },
          select: { id: true, name: true, address: true },
        }),
        tx.tenant.findFirst({
          where: { id: tenantId },
          select: { name: true, logoUrl: true },
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
      ],
    );
    const labels = new Map(catalog.map((c) => [c.id, c.labelEs]));
    const { patient, acceptance } = plan;

    return {
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
      })),
      patient: {
        firstName: patient.firstName,
        lastName: patient.lastName,
        docType: patient.docType,
        docNumber: patient.docNumber,
      },
      clinic: { name: tenant?.name ?? '', logoUrl: tenant?.logoUrl ?? null },
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
          }
        : null,
    };
  }
}
