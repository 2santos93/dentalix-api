import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TreatmentPlanRepricingSource } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  ACCEPTANCE_SUMMARY,
  ITEMS_WITH_ATTRIBUTION,
  mapToEntityWithItems,
  readPlanFacts,
  referenceColumns,
} from './prisma-treatment-plan.repository';
import { lockPlanGroup } from './plan-option-group';
import type {
  ApplyRepricingOutcome,
  DecideRepricing,
  PlanRepricingRepository,
  RepricingIdempotency,
  RepricingRecord,
  RepricingSubject,
  StoredRepricingLine,
} from '../../domain/ports/plan-repricing-repository.port';
import {
  REPRICE_VALIDITY_NOT_RENEWED_MESSAGE,
  type ItemPriceState,
  type RepricingLine,
  type RepricingSkip,
} from '../../application/repricing';

const PLAN_NOT_FOUND_MESSAGE = 'Plan de tratamiento no encontrado';

const dateColumn = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const dayOf = (value: Date): string => value.toISOString().slice(0, 10);

type RepricingRow = Prisma.TreatmentPlanRepricingGetPayload<
  Record<string, never>
>;

function toRecord(row: RepricingRow): RepricingRecord {
  const validity = (issuedOn: Date | null, validUntil: Date | null) =>
    issuedOn && validUntil
      ? { issuedOn: dayOf(issuedOn), validUntil: dayOf(validUntil) }
      : null;
  return {
    id: row.id,
    planId: row.planId,
    patientId: row.patientId,
    locationId: row.locationId,
    actorUserId: row.actorUserId,
    createdAt: row.createdAt,
    previewHash: row.previewHash,
    currency: row.currency,
    rate:
      row.rateCurrency &&
      row.rateFromPerBase &&
      row.rateToPerBase &&
      row.rateSource &&
      row.rateDate
        ? {
            currency: row.rateCurrency,
            fromPerBase: row.rateFromPerBase.toNumber(),
            toPerBase: row.rateToPerBase.toNumber(),
            source: row.rateSource,
            rateDate: dayOf(row.rateDate),
          }
        : null,
    previousValidity: validity(
      row.previousQuoteIssuedOn,
      row.previousQuoteValidUntil,
    ),
    validityRenewed: row.validityRenewed,
    validityNote: row.validityRenewed
      ? null
      : REPRICE_VALIDITY_NOT_RENEWED_MESSAGE,
    validity: validity(row.quoteIssuedOn, row.quoteValidUntil),
    lines: row.lines as unknown as StoredRepricingLine[],
    skipped: row.skipped as unknown as RepricingSkip[],
    totals: {
      before: row.totalBefore.toNumber(),
      after: row.totalAfter.toNumber(),
    },
  };
}

/** La fila de una clave ya usada: la misma petición o otra. */
function replayOf(
  previous: RepricingRow | null,
  idempotency: RepricingIdempotency,
): Exclude<ApplyRepricingOutcome, { kind: 'applied' }> | null {
  if (!previous) return null;
  return previous.requestFingerprint === idempotency.fingerprint
    ? { kind: 'replayed', record: toRecord(previous) }
    : { kind: 'key-reused' };
}

/** Las columnas de precio de un ítem a partir de su estado recotizado. */
function itemPriceColumns(
  state: ItemPriceState,
): Prisma.TreatmentPlanItemUncheckedUpdateInput {
  return {
    catalogPrice: state.catalogPrice,
    basePrice: state.basePrice,
    catalogCurrency: state.catalogCurrency,
    priceSource: state.priceSource,
    agreementId: state.agreementId,
    agreementName: state.agreementName,
    pricingLocationId: state.pricingLocationId,
    ...referenceColumns(state.reference),
    price: state.price,
    discount: state.discount,
    discountReason: state.discountReason,
    discountReasonNote: state.discountReasonNote,
    discountById: state.discountById,
    discountAt: state.discountAt ? new Date(state.discountAt) : null,
    discountLocationId: state.discountLocationId,
  };
}

/**
 * DX-379 (porción B): recotizar un plan abierto. La escritura de la foto del
 * precio de un ítem (moneda del catálogo y referencia, que los triggers de
 * DX-502 y DX-513-bis congelan) solo pasa con la marca
 * `app.plan_item_reprice` de esta transacción, que se pone justo antes de los
 * UPDATE de los ítems y se quita después.
 */
@Injectable()
export class PrismaPlanRepricingRepository implements PlanRepricingRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  load(patientId: string, planId: string): Promise<RepricingSubject | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const plan = await tx.treatmentPlan.findFirst({
        where: { id: planId, patientId, deletedAt: null },
        include: {
          items: ITEMS_WITH_ATTRIBUTION,
          acceptance: ACCEPTANCE_SUMMARY,
        },
      });
      if (!plan) return null;
      return {
        plan: mapToEntityWithItems(plan),
        facts: await readPlanFacts(tx, tenantId, planId),
      };
    });
  }

  findApplied(
    idempotency: RepricingIdempotency,
  ): Promise<Exclude<ApplyRepricingOutcome, { kind: 'applied' }> | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) =>
      replayOf(
        await tx.treatmentPlanRepricing.findFirst({
          where: { tenantId, idempotencyKey: idempotency.key },
        }),
        idempotency,
      ),
    );
  }

  async apply(
    patientId: string,
    planId: string,
    idempotency: RepricingIdempotency,
    actorUserId: string,
    decide: DecideRepricing,
  ): Promise<ApplyRepricingOutcome> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // La segunda petición con la misma clave (doble clic, reintento) espera
      // aquí a la primera y, si ya aplicó, devuelve lo aplicado.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(
        hashtext('dx_plan_repricing_idempotency:' || ${tenantId}),
        hashtext(${idempotency.key})
      )`;
      const replay = replayOf(
        await tx.treatmentPlanRepricing.findFirst({
          where: { tenantId, idempotencyKey: idempotency.key },
        }),
        idempotency,
      );
      if (replay) return replay;

      // Como aceptar o imprimir: el plan y su grupo FOR UPDATE, y se relee.
      const locked = await lockPlanGroup(tx, planId);
      const current = locked
        ? await tx.treatmentPlan.findFirst({
            where: { id: planId, patientId, deletedAt: null },
            include: {
              items: ITEMS_WITH_ATTRIBUTION,
              acceptance: ACCEPTANCE_SUMMARY,
            },
          })
        : null;
      if (!current) throw new NotFoundException(PLAN_NOT_FOUND_MESSAGE);
      const repricing = decide({
        plan: mapToEntityWithItems(current),
        facts: await readPlanFacts(tx, tenantId, planId),
      });

      const locationId = await this.tenantContext.writeLocationId(tx);
      const stored = repricing.lines.map((line) =>
        storedLine(line, locationId),
      );
      await tx.$executeRaw`SELECT set_config('app.plan_item_reprice', 'on', true)`;
      // Todas las líneas: también las que solo cambian la firma del descuento
      // (o la borran) y las que conservan el precio (la validez se reinicia).
      for (const line of stored) {
        await tx.treatmentPlanItem.update({
          where: { id: line.itemId },
          data: itemPriceColumns(line.after),
        });
      }
      await tx.$executeRaw`SELECT set_config('app.plan_item_reprice', '', true)`;

      // I-1: la validez solo se renueva si se recotizaron todos los propuestos.
      const renewed = repricing.validityRenewed ? repricing.validity : null;
      if (renewed) {
        await tx.treatmentPlan.update({
          where: { id: planId },
          data: {
            quoteIssuedOn: dateColumn(renewed.issuedOn),
            quoteValidUntil: dateColumn(renewed.validUntil),
          },
        });
      }
      const rate = repricing.rate;
      const row = await tx.treatmentPlanRepricing.create({
        data: {
          tenantId,
          planId,
          patientId,
          locationId,
          actorUserId,
          source: TreatmentPlanRepricingSource.MANUAL,
          idempotencyKey: idempotency.key,
          requestFingerprint: idempotency.fingerprint,
          previewHash: repricing.previewHash,
          currency: repricing.currency,
          rateCurrency: rate?.currency ?? null,
          rateFromPerBase: rate?.fromPerBase ?? null,
          rateToPerBase: rate?.toPerBase ?? null,
          rateSource: rate?.source ?? null,
          rateDate: rate ? dateColumn(rate.rateDate) : null,
          previousQuoteIssuedOn: repricing.previousValidity
            ? dateColumn(repricing.previousValidity.issuedOn)
            : null,
          previousQuoteValidUntil: repricing.previousValidity
            ? dateColumn(repricing.previousValidity.validUntil)
            : null,
          validityRenewed: repricing.validityRenewed,
          quoteIssuedOn: repricing.validity
            ? dateColumn(repricing.validity.issuedOn)
            : null,
          quoteValidUntil: repricing.validity
            ? dateColumn(repricing.validity.validUntil)
            : null,
          lines: stored as unknown as Prisma.InputJsonValue,
          skipped: repricing.skipped as unknown as Prisma.InputJsonValue,
          totalBefore: repricing.totals.before,
          totalAfter: repricing.totals.after,
        },
      });
      return { kind: 'applied', record: toRecord(row) };
    });
  }
}

/**
 * La línea como se guarda: sin la decisión del descuento y, si lo firma quien
 * recotiza (el % subió por redondeo), con la sede de escritura, como el resto
 * de descuentos (DX-089).
 */
function storedLine(
  line: RepricingLine,
  locationId: string,
): StoredRepricingLine {
  const { discountDecision, ...rest } = line;
  const signed = discountDecision?.discountStamp ? locationId : undefined;
  return signed === undefined
    ? rest
    : { ...rest, after: { ...rest.after, discountLocationId: signed } };
}
