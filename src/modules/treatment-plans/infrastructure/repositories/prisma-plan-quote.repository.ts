import {
  clinicLogoKeyToFreeze,
  clinicLogoPublicUrl,
} from '../../../../shared/storage/clinic-logo-url';
import {
  CLINIC_FISCAL_SELECT,
  clinicFiscalOf,
} from '../../../../shared/clinic/clinic-fiscal';
import { Injectable } from '@nestjs/common';
import {
  Prisma,
  TreatmentPlanRepricingSource,
  type ConsentSignerType,
  type SignatureRequestChannel,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  DOCUMENT_REGIONAL_SELECT,
  documentRegional,
} from '../../../../shared/locations/document-regional';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { isValidTimeZone } from '../../../../shared/time/civil-day';
import type {
  AcceptPlanOutcome,
  AcceptReprice,
  AcceptRepriced,
  PlanAcceptanceRemoteEvidence,
  NewPlanAcceptance,
  PlanQuoteRepository,
  PlanQuoteSource,
} from '../../domain/ports/plan-quote-repository.port';
import type { Repricing } from '../../application/repricing';
import type { RepricingRecord } from '../../domain/ports/plan-repricing-repository.port';
import { acceptPlanInTx, lockPlanGroup } from './plan-option-group';
import {
  loadRepricingSubjectInTx,
  writeRepricingInTx,
} from './prisma-plan-repricing.repository';
import {
  PLATFORM_DEFAULT_QUOTE_VALIDITY_DAYS,
  type QuoteValidity,
} from '../../domain/quote-validity';
import { NO_EXPIRED_ACCEPTANCE } from '../../domain/expired-quote-acceptance';

const PROCEDURE_FALLBACK = 'Procedimiento';

/** Una columna DATE (Prisma la lee a medianoche UTC) como `YYYY-MM-DD`. */
export function civilDayOf(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}
const UNKNOWN_PROFESSIONAL = 'Profesional';

class AlreadyAccepted extends Error {}

/**
 * El plan desapareció DESPUÉS de escribir algo (recotización o aceptación):
 * se lanza para que la transacción se deshaga y se responde 404.
 */
class VanishedAfterWrite extends Error {}

/** Deshace la transacción de la vista previa llevándose su resultado. */
class DryRun extends Error {
  constructor(
    readonly result: { source: PlanQuoteSource; repricing: Repricing } | null,
  ) {
    super('dry run');
  }
}

/** Una fecha `YYYY-MM-DD` como columna DATE. */
const dateColumn = (day: string | null): Date | null =>
  day === null ? null : new Date(`${day}T00:00:00.000Z`);

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
    decide: (
      source: PlanQuoteSource,
      repriced: AcceptRepriced | null,
    ) => NewPlanAcceptance,
    reprice?: AcceptReprice,
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

        // DX-379 (C): «actualizar los precios» de un presupuesto vencido, en
        // esta misma transacción y antes de firmar el presupuesto recotizado.
        let signing = source;
        let repriced: AcceptRepriced | null = null;
        if (reprice) {
          const done = await repriceInTx(tx, {
            tenantId,
            patientId,
            planId,
            locationId,
            source,
            reprice,
          });
          if (!done) throw new VanishedAfterWrite();
          signing = done.source;
          repriced = { repricingId: done.record.id, before: source };
        }

        const row = decide(signing, repriced);
        const expiry = row.expiry ?? {
          ...NO_EXPIRED_ACCEPTANCE,
          quoteValidUntil: signing.plan.quoteValidUntil,
        };
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
              // DX-019-bis (B): el logo de este instante, leído en esta
              // transacción con el plan bloqueado.
              clinicLogoKey: signing.clinic.logoKey,
              // DX-379 (C): cómo se aceptó, fuera del contenido firmado.
              quoteValidUntil: dateColumn(expiry.quoteValidUntil),
              expiredMode: expiry.mode,
              expiredReason: expiry.reason,
              expiredNote: expiry.note,
              repricingId: expiry.repricingId,
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
        if (!accepted) throw new VanishedAfterWrite();
        return { kind: 'ACCEPTED', source: accepted } as const;
      });
    } catch (error) {
      if (error instanceof AlreadyAccepted) return { kind: 'ALREADY_ACCEPTED' };
      if (error instanceof VanishedAfterWrite) return { kind: 'NOT_FOUND' };
      throw error;
    }
  }

  async previewRepriced(
    patientId: string,
    planId: string,
    reprice: AcceptReprice,
  ): Promise<{ source: PlanQuoteSource; repricing: Repricing } | null> {
    const tenantId = this.requireTenantId();
    try {
      await this.prisma.runWithTenant(async (tx) => {
        // Lo mismo que `accept` con `reprice`, hasta releer el presupuesto
        // recotizado; después se deshace todo (DryRun). Así la vista previa
        // es exactamente lo que firmaría la aceptación.
        const owned = await tx.treatmentPlan.findFirst({
          where: { id: planId, patientId, deletedAt: null },
          select: { id: true },
        });
        const locked = owned ? await lockPlanGroup(tx, planId) : null;
        if (!locked) throw new DryRun(null);
        const locationId = await this.tenantContext.writeLocationId(tx);
        const source = await readPlanQuoteSource(
          tx,
          tenantId,
          patientId,
          planId,
          locationId,
        );
        if (!source) throw new DryRun(null);
        const done = await repriceInTx(tx, {
          tenantId,
          patientId,
          planId,
          locationId,
          source,
          reprice,
        });
        throw new DryRun(
          done ? { source: done.source, repricing: done.repricing } : null,
        );
      });
    } catch (error) {
      if (error instanceof DryRun) return error.result;
      throw error;
    }
    throw new Error('previewRepriced: la transacción no se deshizo');
  }

  async issue(
    patientId: string,
    planId: string,
    decide: (source: PlanQuoteSource) => QuoteValidity | null,
  ): Promise<PlanQuoteSource | null> {
    const tenantId = this.requireTenantId();
    // M-2: primero SIN bloquear. La mayoría de impresiones son reimpresiones
    // (fechas ya guardadas, plan firmado o cerrado) y no escriben nada: no
    // toman el FOR UPDATE del grupo, que haría esperar a los abonos, ítems y
    // asientos que insertan con FK al plan.
    const read = await this.loadSource(patientId, planId);
    if (!read) return null;
    if (!decide(read)) return read;
    return this.prisma.runWithTenant(async (tx) => {
      // Hay que guardar fechas: con el plan bloqueado, como al aceptar. Dos
      // primeras impresiones simultáneas esperan aquí; la segunda relee, ve
      // las fechas de la primera y no escribe (y una firma concurrente espera
      // y luego ve las fechas, o al revés: la impresión ve el plan firmado).
      const locked = await lockPlanGroup(tx, planId);
      if (!locked) return null;
      const locationId = await this.tenantContext.writeLocationId(tx);
      const source = await readPlanQuoteSource(
        tx,
        tenantId,
        patientId,
        planId,
        locationId,
      );
      if (!source) return null;
      const validity = decide(source);
      if (!validity) return source;
      // Solo si aún no tiene fechas: la primera impresión manda.
      const { count } = await tx.treatmentPlan.updateMany({
        where: { id: planId, quoteIssuedOn: null, quoteValidUntil: null },
        data: {
          quoteIssuedOn: new Date(`${validity.issuedOn}T00:00:00.000Z`),
          quoteValidUntil: new Date(`${validity.validUntil}T00:00:00.000Z`),
        },
      });
      if (count === 0) return source;
      return readPlanQuoteSource(tx, tenantId, patientId, planId, locationId);
    });
  }
}

/**
 * DX-379 (C): recotiza en la transacción de la firma (el plan ya está
 * bloqueado): relee el plan como lo ve la recotización, deja que `decide`
 * valide y calcule, escribe (source ACCEPT, sin clave de idempotencia: la
 * firma ya es única por plan) y relee el presupuesto recotizado. `null` si el
 * plan ya no existe para este paciente.
 */
async function repriceInTx(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    patientId: string;
    planId: string;
    locationId: string;
    source: PlanQuoteSource;
    reprice: AcceptReprice;
  },
): Promise<{
  source: PlanQuoteSource;
  repricing: Repricing;
  record: RepricingRecord;
} | null> {
  const { tenantId, patientId, planId, locationId } = args;
  const subject = await loadRepricingSubjectInTx(
    tx,
    tenantId,
    patientId,
    planId,
  );
  if (!subject) return null;
  const repricing = args.reprice.decide(args.source, subject);
  const record = await writeRepricingInTx(tx, {
    tenantId,
    planId,
    patientId,
    locationId,
    actorUserId: args.reprice.actorUserId,
    source: TreatmentPlanRepricingSource.ACCEPT,
    idempotency: null,
    repricing,
  });
  const source = await readPlanQuoteSource(
    tx,
    tenantId,
    patientId,
    planId,
    locationId,
  );
  return source ? { source, repricing, record } : null;
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
      quoteIssuedOn: true,
      quoteValidUntil: true,
      presentedLocationId: true,
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
          catalogCurrency: true,
          catalogPrice: true,
          agreementId: true,
          agreementName: true,
        },
      },
      acceptance: {
        select: {
          locationId: true,
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
          clinicLogoKey: true,
          quoteValidUntil: true,
          expiredMode: true,
          expiredReason: true,
          expiredNote: true,
          repricingId: true,
          // DX-514: el impreso dice si firmó el paciente o su representante.
          signatureRequest: { select: { signerType: true } },
        },
      },
    },
  });
  if (!plan || plan.patient.deletedAt !== null) return null;

  const [location, tenant, professional, catalog, zoneOf] = await Promise.all([
    tx.location.findFirstOrThrow({
      where: { id: locationId, deletedAt: null },
      select: {
        id: true,
        name: true,
        address: true,
        ...DOCUMENT_REGIONAL_SELECT,
      },
    }),
    tx.tenant.findFirst({
      where: { id: tenantId },
      select: {
        name: true,
        logoKey: true,
        quoteValidityDays: true,
        ...CLINIC_FISCAL_SELECT,
      },
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
  // DX-379 (C): el vencimiento se decide con el día de la sede de la
  // presentación (como `quoteExpired`, D-13) y su fecha se escribe con el
  // formato de esa misma sede; sin presentar, con los de esta. Tolerante: una
  // sede de presentación sin zona válida da zona null.
  const presented = plan.presentedLocationId;
  const quoteLocation =
    presented === null || presented === locationId
      ? {
          id: locationId,
          timeZone: zoneOf(locationId),
          locale: location.locale,
          hourCycle: location.hourCycle,
        }
      : await presentationRegional(tx, tenantId, presented);
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
  // DX-514: aceptado, las horas del impreso (firma, envío) son las de la sede
  // donde se aceptó, como en la ficha, aunque se imprima desde otra sede; la
  // de la firma aunque luego se archivara. Sin aceptar, la del request.
  const regional =
    acceptance && acceptance.locationId !== location.id
      ? documentRegional(
          await tx.location.findFirst({
            where: { id: acceptance.locationId, tenantId },
            select: DOCUMENT_REGIONAL_SELECT,
          }),
        )
      : documentRegional(location);

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
      quoteIssuedOn: civilDayOf(plan.quoteIssuedOn),
      quoteValidUntil: civilDayOf(plan.quoteValidUntil),
      presentedLocationId: plan.presentedLocationId,
      quoteRegional: {
        locationId: quoteLocation.id,
        timeZone: quoteLocation.timeZone,
        locale: quoteLocation.locale,
        hourCycle: quoteLocation.hourCycle,
      },
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
      listPriceCurrency: item.catalogCurrency,
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
      logoUrl: clinicLogoPublicUrl(tenant?.logoKey ?? null),
      logoKey: clinicLogoKeyToFreeze(tenant?.logoKey ?? null),
      fiscal: clinicFiscalOf(tenant),
      quoteValidityDays:
        tenant?.quoteValidityDays ?? PLATFORM_DEFAULT_QUOTE_VALIDITY_DAYS,
    },
    location: {
      id: location.id,
      name: location.name,
      address: location.address,
      timeZone: zoneOf(location.id),
    },
    regional,
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
          // DX-019-bis (B): el congelado al firmar, nunca el de hoy.
          clinicLogoUrl: clinicLogoPublicUrl(acceptance.clinicLogoKey),
          expiry: {
            quoteValidUntil: civilDayOf(acceptance.quoteValidUntil),
            mode: acceptance.expiredMode,
            reason: acceptance.expiredReason,
            note: acceptance.expiredNote,
            repricingId: acceptance.repricingId,
          },
        }
      : null,
  };
}

/**
 * DX-379 (C): zona (válida o null), formato y reloj de la sede de la
 * presentación de un plan, bajo la RLS de la clínica.
 */
async function presentationRegional(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationId: string,
): Promise<{
  id: string;
  timeZone: string | null;
  locale: string | null;
  hourCycle: string | null;
}> {
  const row = await tx.location.findFirst({
    where: { id: locationId, tenantId },
    select: { timeZone: true, locale: true, hourCycle: true },
  });
  const zone = row?.timeZone ?? null;
  return {
    id: locationId,
    timeZone: zone && isValidTimeZone(zone) ? zone : null,
    locale: row?.locale ?? null,
    hourCycle: row?.hourCycle ?? null,
  };
}

/**
 * Evidencias congeladas de una aceptación a distancia, o `null` si se firmó
 * en la clínica. Exportada para sus pruebas (DX-514).
 */
export function remoteEvidenceOf(acceptance: {
  signatureRequestId: string | null;
  remoteChannel: SignatureRequestChannel | null;
  remoteDestinationMasked: string | null;
  remoteSentAt: Date | null;
  remoteOpenedAt: Date | null;
  remoteVerifiedAt: Date | null;
  signatureRequest: { signerType: ConsentSignerType } | null;
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
    // Sin la solicitud (no debería pasar: FK con Restrict), sigue siendo a
    // distancia; solo falta decir si firmó el paciente o su representante.
    ...(acceptance.signatureRequest
      ? { signerType: acceptance.signatureRequest.signerType }
      : {}),
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
