import {
  DOCUMENT_REGIONAL_SELECT,
  documentRegional,
} from '../../../shared/locations/document-regional';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type TreatmentPlanStatus } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { prismaRuleCode } from '../../../shared/prisma/prisma-exception.filter';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  NO_CURRENCY_TEXTS,
  readCurrencyTexts,
  type CurrencyTexts,
} from '../../../shared/format/currency-text';
import type { RegionalFormat } from '../../../shared/format/regional-format';
import { requireLocationFormat } from '../../../shared/locations/location-regional';
import { resolveReferenceLocation } from '../../../shared/locations/reference-location';
import { resolveLocationTimeZones } from '../../../shared/locations/location-time-zone';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../audit/domain/config-audit';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import { lockDailyRefundDay } from './daily-refund-cap-lock';
import { lockOpenSessionOf } from '../../cash-sessions/infrastructure/payment-cash-session';
import { enqueuePlanRebalance } from '../../payments/infrastructure/allocations/prisma-plan-allocation.repository';
import {
  formatReceiptNumber,
  legacyReceiptReference,
} from '../../payments/domain/receipt-number';
import {
  CREDIT_CASH_LOCATION_REQUIRED_MESSAGE,
  CREDIT_CASH_SESSION_REQUIRED_MESSAGE,
  CREDIT_CHANGED_MESSAGE,
  CREDIT_IDEMPOTENCY_REUSED_MESSAGE,
  CREDIT_PAYMENT_NOT_OF_PLAN_MESSAGE,
  CREDIT_TARGET_NOT_BILLABLE_MESSAGE,
  DailyRefundCapExceededError,
  dailyRefundRemainingCents,
  formatRefundNumber,
  fromCents,
  planCreditCents,
  refundSeriesOf,
  toCents,
} from '../domain/patient-credit';
import type {
  CreateRefundInput,
  CreateTransferInput,
  CreditRefundRecord,
  CreditTransferRecord,
  PatientCreditMovements,
  PatientCreditRepository,
  PlanCreditState,
  RefundReceiptSnapshot,
} from '../domain/ports/patient-credit-repository.port';
import { isPlanBillable } from '../../treatment-plans/domain/plan-status-machine';

type Tx = Prisma.TransactionClient;

interface PlanCreditRow {
  id: string;
  patientId: string;
  status: TreatmentPlanStatus;
  currency: string;
  billable: string;
  paid: string;
  entries: string;
  pendingOther: number;
}

const TRANSFER_SELECT = {
  id: true,
  patientId: true,
  locationId: true,
  sourcePlanId: true,
  targetPlanId: true,
  currency: true,
  amount: true,
  reason: true,
  createdById: true,
  createdAt: true,
  idempotencyFingerprint: true,
} satisfies Prisma.PatientCreditTransferSelect;

const REFUND_SELECT = {
  id: true,
  patientId: true,
  locationId: true,
  treatmentPlanId: true,
  currency: true,
  amount: true,
  method: true,
  reason: true,
  cashSessionId: true,
  seriesPrefix: true,
  number: true,
  snapshot: true,
  createdById: true,
  createdAt: true,
  idempotencyFingerprint: true,
  // DX-354: la región de la sede del comprobante.
  location: { select: DOCUMENT_REGIONAL_SELECT },
  payments: { select: { paymentId: true }, orderBy: { paymentId: 'asc' } },
} satisfies Prisma.PatientCreditRefundSelect;

type TransferRow = Prisma.PatientCreditTransferGetPayload<{
  select: typeof TRANSFER_SELECT;
}>;
type RefundRow = Prisma.PatientCreditRefundGetPayload<{
  select: typeof REFUND_SELECT;
}>;

function toTransfer(row: TransferRow): CreditTransferRecord {
  return { ...row, amount: row.amount.toNumber() };
}

function toRefund(row: RefundRow): CreditRefundRecord {
  const { payments, seriesPrefix, number, snapshot, location, ...rest } = row;
  return {
    ...rest,
    regional: documentRegional(location),
    amount: row.amount.toNumber(),
    number: formatRefundNumber(seriesPrefix, number),
    paymentIds: payments.map((p) => p.paymentId),
    snapshot: snapshot as unknown as RefundReceiptSnapshot,
  };
}

/**
 * La otra petición con la misma clave ganó la carrera: si su cuerpo era otro,
 * 422 (igual que la repetición secuencial del caso de uso), nunca su resultado.
 */
function sameRequestOrThrow<
  T extends { idempotencyFingerprint: string | null },
>(existing: T, fingerprint: string): T {
  if (existing.idempotencyFingerprint !== fingerprint) {
    throw new UnprocessableEntityException(CREDIT_IDEMPOTENCY_REUSED_MESSAGE);
  }
  return existing;
}

function isUniqueViolation(error: unknown): boolean {
  return prismaRuleCode(error) === '23505';
}

/**
 * Saldo a favor (DX-253) bajo `runWithTenant` (RLS FORCE) y con `tenantId`
 * explícito en cada consulta. Las escrituras bloquean el/los planes con
 * `FOR NO KEY UPDATE` (orden por id: sin interbloqueos entre un traspaso
 * A→B y otro B→A) y RECALCULAN el saldo dentro del bloqueo: dos devoluciones
 * simultáneas sobre el mismo saldo se ordenan y la segunda ve lo que dejó la
 * primera (409 si ya no alcanza). Las FK de los abonos nuevos (KEY SHARE) no
 * esperan a este bloqueo.
 */
@Injectable()
export class PrismaPatientCreditRepository implements PatientCreditRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  readPlanCredit(planId: string): Promise<PlanCreditState | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant((tx) =>
      this.planCredit(tx, tenantId, planId),
    );
  }

  /** Sumas del plan en su moneda: UNA consulta con tres subconsultas. */
  private async planCredit(
    tx: Tx,
    tenantId: string,
    planId: string,
  ): Promise<PlanCreditState | null> {
    const [row] = await tx.$queryRaw<PlanCreditRow[]>`
      SELECT tp."id", tp."patientId", tp."status", tp."currency",
             COALESCE((
               SELECT pg_catalog.sum(i."price") - pg_catalog.sum(i."discount")
                 FROM "treatment_plan_items" i
                WHERE i."tenantId" = tp."tenantId" AND i."planId" = tp."id"
                  AND i."deletedAt" IS NULL AND i."status" IN ('ACCEPTED', 'DONE')
             ), 0)::text AS "billable",
             -- DX-472-bis: lo abonado en otra moneda cuenta por su base (el
             -- abono convertido con su tasa congelada, inmutable), la misma
             -- cifra que el saldo del plan; sin base todavía, no cuenta.
             COALESCE((
               SELECT pg_catalog.sum(CASE WHEN p."currency" = tp."currency"
                                          THEN p."amount" ELSE b."amount" END)
                 FROM "payments" p
                 LEFT JOIN "payment_plan_amounts" b
                   ON b."tenantId" = p."tenantId" AND b."paymentId" = p."id"
                  AND b."currency" = tp."currency"
                WHERE p."tenantId" = tp."tenantId" AND p."treatmentPlanId" = tp."id"
                  AND p."deletedAt" IS NULL
                  AND (p."currency" = tp."currency" OR b."paymentId" IS NOT NULL)
             ), 0)::text AS "paid",
             COALESCE((
               SELECT pg_catalog.sum(e."amount") FROM "patient_credit_entries" e
                WHERE e."tenantId" = tp."tenantId" AND e."treatmentPlanId" = tp."id"
                  AND e."currency" = tp."currency"
             ), 0)::text AS "entries",
             -- DX-472-bis (revisión B3): abonos en otra moneda aún sin base,
             -- que todavía no cuentan (para explicar un «supera»).
             (SELECT pg_catalog.count(*)::int FROM "payments" p
               WHERE p."tenantId" = tp."tenantId" AND p."treatmentPlanId" = tp."id"
                 AND p."deletedAt" IS NULL AND p."currency" <> tp."currency"
                 AND NOT EXISTS (
                   SELECT 1 FROM "payment_plan_amounts" b
                    WHERE b."tenantId" = p."tenantId" AND b."paymentId" = p."id"
                      AND b."currency" = tp."currency")) AS "pendingOther"
        FROM "treatment_plans" tp
       WHERE tp."tenantId" = ${tenantId}::uuid AND tp."id" = ${planId}::uuid
         AND tp."deletedAt" IS NULL`;
    if (!row) return null;
    const billableCents = isPlanBillable(row.status)
      ? toCents(Number(row.billable))
      : 0;
    const paidCents = toCents(Number(row.paid));
    const entriesCents = toCents(Number(row.entries));
    return {
      planId: row.id,
      patientId: row.patientId,
      status: row.status,
      currency: row.currency,
      billableCents,
      paidCents,
      entriesCents,
      creditCents: planCreditCents({ billableCents, paidCents, entriesCents }),
      pendingOtherCurrencyPayments: row.pendingOther,
    };
  }

  private async lockPlans(
    tx: Tx,
    tenantId: string,
    planIds: string[],
  ): Promise<void> {
    const sorted = [...new Set(planIds)].sort();
    await tx.$queryRaw`
      SELECT "id" FROM "treatment_plans"
       WHERE "tenantId" = ${tenantId}::uuid
         AND "id" = ANY(${sorted}::uuid[])
       ORDER BY "id"
       FOR NO KEY UPDATE`;
  }

  async receptionCapCents(): Promise<number> {
    const tenantId = this.tenantId();
    const tenant = await this.prisma.runWithTenant((tx) =>
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: { creditReceptionMaxAmount: true },
      }),
    );
    return toCents(tenant?.creditReceptionMaxAmount.toNumber() ?? 0);
  }

  async referenceLocationFormat(): Promise<RegionalFormat> {
    const tenantId = this.tenantId();
    const locationId = this.tenantContext.getLocationId() ?? null;
    const reference = await this.prisma.runWithTenant((tx) =>
      resolveReferenceLocation(tx, tenantId, locationId),
    );
    return requireLocationFormat(reference);
  }

  async currencyTexts(): Promise<CurrencyTexts> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: this.tenantId() },
      select: { currencyTexts: true },
    });
    return tenant ? readCurrencyTexts(tenant.currencyTexts) : NO_CURRENCY_TEXTS;
  }

  async locationFormat(locationId: string): Promise<RegionalFormat> {
    const tenantId = this.tenantId();
    const location = await this.prisma.runWithTenant((tx) =>
      tx.location.findFirstOrThrow({
        where: { tenantId, id: locationId },
        select: { id: true, locale: true, hourCycle: true },
      }),
    );
    return requireLocationFormat(location);
  }

  async updateReceptionCap(
    cents: number,
    audit: AuditRequestContext,
  ): Promise<number> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Fila bloqueada: dos cambios a la vez se ordenan y cada uno audita su
      // antes real.
      const [locked] = await tx.$queryRaw<{ cap: Prisma.Decimal }[]>`
        SELECT "creditReceptionMaxAmount" AS cap
          FROM "tenants" WHERE "id" = ${tenantId}::uuid FOR UPDATE`;
      const tenant = await tx.tenant.update({
        where: { id: tenantId },
        data: {
          creditReceptionMaxAmount: new Prisma.Decimal(fromCents(cents)),
        },
        select: { creditReceptionMaxAmount: true },
      });
      const event = configAuditEvent(audit, {
        action: 'UPDATE',
        resourceType: 'PATIENT_CREDIT',
        resourceId: tenantId,
        reason: 'POLICY',
        before: {
          creditReceptionMaxAmount: fromCents(
            toCents(new Prisma.Decimal(locked.cap).toNumber()),
          ),
        },
        after: {
          creditReceptionMaxAmount: fromCents(
            toCents(tenant.creditReceptionMaxAmount.toNumber()),
          ),
        },
      });
      if (event) await writeAuditEvent(tx, event);
      return toCents(tenant.creditReceptionMaxAmount.toNumber());
    });
  }

  async findTransferByKey(key: string): Promise<CreditTransferRecord | null> {
    const tenantId = this.tenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      tx.patientCreditTransfer.findFirst({
        where: { tenantId, idempotencyKey: key },
        select: TRANSFER_SELECT,
      }),
    );
    return row ? toTransfer(row) : null;
  }

  async findRefundByKey(key: string): Promise<CreditRefundRecord | null> {
    const tenantId = this.tenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      tx.patientCreditRefund.findFirst({
        where: { tenantId, idempotencyKey: key },
        select: REFUND_SELECT,
      }),
    );
    return row ? toRefund(row) : null;
  }

  async createTransfer(
    input: CreateTransferInput,
  ): Promise<CreditTransferRecord> {
    const tenantId = this.tenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        await this.lockPlans(tx, tenantId, [
          input.sourcePlanId,
          input.targetPlanId,
        ]);
        const source = await this.planCredit(tx, tenantId, input.sourcePlanId);
        if (
          !source ||
          source.currency !== input.currency ||
          source.creditCents < input.amountCents
        ) {
          throw new ConflictException(CREDIT_CHANGED_MESSAGE);
        }
        // El destino se pudo cancelar, rechazar o cambiar de moneda entre la
        // lectura del caso de uso y el bloqueo: se relee bajo el bloqueo (el
        // cambio espera a este COMMIT o ya está confirmado). Un asiento en
        // otra moneda que la del plan no contaría en ningún saldo (DX-438).
        const target = await this.planCredit(tx, tenantId, input.targetPlanId);
        if (target && target.currency !== input.currency) {
          throw new ConflictException(CREDIT_CHANGED_MESSAGE);
        }
        if (!target || !isPlanBillable(target.status)) {
          throw new ConflictException(CREDIT_TARGET_NOT_BILLABLE_MESSAGE);
        }
        const locationId = await this.tenantContext.writeLocationId(tx);
        const amount = new Prisma.Decimal(fromCents(input.amountCents));
        const transfer = await tx.patientCreditTransfer.create({
          data: {
            tenantId,
            locationId,
            patientId: source.patientId,
            sourcePlanId: input.sourcePlanId,
            targetPlanId: input.targetPlanId,
            currency: input.currency,
            amount,
            reason: input.reason,
            createdById: input.userId,
            idempotencyKey: input.idempotencyKey ?? null,
            idempotencyFingerprint: input.idempotencyKey
              ? input.fingerprint
              : null,
          },
          select: TRANSFER_SELECT,
        });
        // El par de asientos enlazados: sale del origen, entra en el destino.
        await tx.patientCreditEntry.createMany({
          data: [
            {
              tenantId,
              patientId: source.patientId,
              treatmentPlanId: input.sourcePlanId,
              currency: input.currency,
              amount: amount.negated(),
              kind: 'TRANSFER_OUT',
              transferId: transfer.id,
            },
            {
              tenantId,
              patientId: source.patientId,
              treatmentPlanId: input.targetPlanId,
              currency: input.currency,
              amount,
              kind: 'TRANSFER_IN',
              transferId: transfer.id,
            },
          ],
        });
        // DX-399-ter (N1): lo recibido por traspaso absorbe las salidas del
        // destino aunque llegue después (`credit-netting`), así que puede
        // devolver excedente a un abono anterior: el destino se encola para el
        // reparto en ESTA transacción, como el alta o la anulación de un abono.
        // El origen también (inocuo: una salida nunca da más que repartir).
        await enqueuePlanRebalance(tx, tenantId, input.targetPlanId);
        await enqueuePlanRebalance(tx, tenantId, input.sourcePlanId);
        return toTransfer(transfer);
      });
    } catch (error) {
      // Dos peticiones con la misma clave a la vez: la otra ya entró.
      if (input.idempotencyKey && isUniqueViolation(error)) {
        const existing = await this.findTransferByKey(input.idempotencyKey);
        if (existing) return sameRequestOrThrow(existing, input.fingerprint);
      }
      throw error;
    }
  }

  async createRefund(input: CreateRefundInput): Promise<CreditRefundRecord> {
    const tenantId = this.tenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        await this.lockPlans(tx, tenantId, [input.planId]);
        // DX-462: un reintento con la misma clave que esperaba al bloqueo
        // devuelve la devolución original (ya en la suma del tope), no un 403.
        const replayed = await this.replayRefundIn(tx, tenantId, input);
        if (replayed) return replayed;
        const plan = await this.planCredit(tx, tenantId, input.planId);
        // DX-438: el saldo se leyó en la moneda del plan; si cambió antes del
        // bloqueo, la devolución saldría en una moneda que ya no es la suya.
        if (
          !plan ||
          plan.currency !== input.currency ||
          plan.creditCents < input.amountCents
        ) {
          throw new ConflictException(CREDIT_CHANGED_MESSAGE);
        }
        const paymentIds = [...new Set(input.paymentIds)].sort();
        const payments = await tx.payment.findMany({
          where: {
            tenantId,
            id: { in: paymentIds },
            treatmentPlanId: input.planId,
            deletedAt: null,
          },
          select: {
            id: true,
            paidAt: true,
            amount: true,
            currency: true,
            receipt: { select: { seriesPrefix: true, number: true } },
            splitHead: {
              select: {
                receipt: { select: { seriesPrefix: true, number: true } },
              },
            },
          },
          orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
        });
        if (payments.length !== paymentIds.length) {
          throw new BadRequestException(CREDIT_PAYMENT_NOT_OF_PLAN_MESSAGE);
        }

        // D1: el efectivo sale de la caja de UNA sede. Sin `X-Location-Id`
        // (vista «Todas las sedes») y con varias sedes posibles, no se elige
        // la sede por defecto: 400. Con una sola sede posible no hay duda.
        // Las demás formas de devolver no tocan caja.
        if (input.method === 'CASH' && !this.tenantContext.getLocationId()) {
          await this.assertSingleWriteLocation(tx);
        }
        const locationId = await this.tenantContext.writeLocationId(tx);
        // DX-378: el comprobante pinta fechas y horas en la zona de la sede
        // (y DX-462: el día del tope diario es el civil de esa zona).
        const timeZone = (
          await resolveLocationTimeZones(tx, tenantId, [locationId])
        )(locationId);
        if (input.dailyCap) {
          await this.assertDailyRefundCap(
            tx,
            tenantId,
            locationId,
            timeZone,
            input,
            input.dailyCap,
          );
          // Tras esperar el bloqueo, otra petición con la misma clave pudo
          // entrar: es la original, no un exceso del tope.
          const again = await this.replayRefundIn(tx, tenantId, input);
          if (again) return again;
        }
        let cashSessionId: string | null = null;
        if (input.method === 'CASH') {
          // FOR SHARE hasta el COMMIT: un cierre simultáneo espera al egreso.
          cashSessionId = await lockOpenSessionOf(
            tx,
            tenantId,
            locationId,
            input.userId,
          );
          if (!cashSessionId) {
            const tenant = await tx.tenant.findUnique({
              where: { id: tenantId },
              select: { cashRequireOpenSession: true },
            });
            if (tenant?.cashRequireOpenSession) {
              throw new ConflictException(CREDIT_CASH_SESSION_REQUIRED_MESSAGE);
            }
          }
        }

        const [location, tenant, patient, planRow, user] = await Promise.all([
          tx.location.findFirstOrThrow({
            where: { tenantId, id: locationId },
            select: {
              id: true,
              name: true,
              address: true,
              receiptPrefix: true,
            },
          }),
          tx.tenant.findUniqueOrThrow({
            where: { id: tenantId },
            select: { name: true },
          }),
          tx.patient.findFirstOrThrow({
            where: { tenantId, id: plan.patientId },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              documentType: true,
              docTypeLabel: true,
              docNumber: true,
            },
          }),
          tx.treatmentPlan.findFirstOrThrow({
            where: { tenantId, id: input.planId },
            select: { id: true, optionLabel: true, createdAt: true },
          }),
          tx.user.findUnique({
            where: { id: input.userId },
            select: { fullName: true },
          }),
        ]);
        if (!location.receiptPrefix) {
          // El trigger de `locations` la pone al crear la sede (DX-136).
          throw new Error('La sede no tiene serie de recibos');
        }
        const series = refundSeriesOf(location.receiptPrefix);
        // UPSERT del contador: la fila queda bloqueada hasta el COMMIT (dos
        // devoluciones de la misma sede se ordenan; un rollback no deja hueco).
        const [{ lastNumber }] = await tx.$queryRaw<{ lastNumber: number }[]>`
          INSERT INTO "patient_credit_refund_counters" ("tenantId", "seriesPrefix", "lastNumber")
          VALUES (${tenantId}::uuid, ${series}, 1)
          ON CONFLICT ("tenantId", "seriesPrefix")
          DO UPDATE SET "lastNumber" = "patient_credit_refund_counters"."lastNumber" + 1
          RETURNING "lastNumber"`;

        const snapshot: RefundReceiptSnapshot = {
          number: formatRefundNumber(series, lastNumber),
          issuedAt: new Date().toISOString(),
          clinic: { name: tenant.name },
          location: {
            id: location.id,
            name: location.name,
            address: location.address,
            timeZone,
          },
          patient: {
            id: patient.id,
            fullName: `${patient.firstName} ${patient.lastName}`.trim(),
            documentType: patient.documentType,
            docTypeLabel: patient.docTypeLabel,
            docNumber: patient.docNumber,
          },
          plan: {
            id: planRow.id,
            label: planRow.optionLabel,
            createdAt: planRow.createdAt.toISOString(),
          },
          amount: fromCents(input.amountCents),
          currency: input.currency,
          method: input.method,
          reason: input.reason,
          payments: payments.map((p) => {
            const receipt = p.receipt ?? p.splitHead?.receipt ?? null;
            return {
              id: p.id,
              paidAt: p.paidAt.toISOString(),
              amount: p.amount.toNumber(),
              currency: p.currency,
              receiptNumber: receipt
                ? formatReceiptNumber(receipt.seriesPrefix, receipt.number)
                : legacyReceiptReference(p.id),
            };
          }),
          creditBefore: fromCents(plan.creditCents),
          creditAfter: fromCents(plan.creditCents - input.amountCents),
          refundedBy: { id: input.userId, fullName: user?.fullName ?? null },
          cashSessionId,
        };

        const amount = new Prisma.Decimal(fromCents(input.amountCents));
        const refund = await tx.patientCreditRefund.create({
          data: {
            tenantId,
            locationId,
            patientId: plan.patientId,
            treatmentPlanId: input.planId,
            currency: input.currency,
            amount,
            method: input.method,
            reason: input.reason,
            cashSessionId,
            seriesPrefix: series,
            number: lastNumber,
            snapshot: snapshot as unknown as Prisma.InputJsonValue,
            createdById: input.userId,
            idempotencyKey: input.idempotencyKey ?? null,
            idempotencyFingerprint: input.idempotencyKey
              ? input.fingerprint
              : null,
          },
          select: { id: true },
        });
        await tx.patientCreditRefundPayment.createMany({
          data: paymentIds.map((paymentId) => ({
            tenantId,
            refundId: refund.id,
            paymentId,
            treatmentPlanId: input.planId,
          })),
        });
        await tx.patientCreditEntry.create({
          data: {
            tenantId,
            patientId: plan.patientId,
            treatmentPlanId: input.planId,
            currency: input.currency,
            amount: amount.negated(),
            kind: 'REFUND',
            refundId: refund.id,
          },
        });
        const row = await tx.patientCreditRefund.findFirstOrThrow({
          where: { tenantId, id: refund.id },
          select: REFUND_SELECT,
        });
        return toRefund(row);
      });
    } catch (error) {
      if (input.idempotencyKey && isUniqueViolation(error)) {
        const existing = await this.findRefundByKey(input.idempotencyKey);
        if (existing) return sameRequestOrThrow(existing, input.fingerprint);
      }
      throw error;
    }
  }

  /** La devolución ya guardada con esa clave (misma petición), si existe. */
  private async replayRefundIn(
    tx: Tx,
    tenantId: string,
    input: CreateRefundInput,
  ): Promise<CreditRefundRecord | null> {
    if (!input.idempotencyKey) return null;
    const row = await tx.patientCreditRefund.findFirst({
      where: { tenantId, idempotencyKey: input.idempotencyKey },
      select: REFUND_SELECT,
    });
    return row ? sameRequestOrThrow(toRefund(row), input.fingerprint) : null;
  }

  /**
   * DX-462: tope diario acumulado de RECEPTION. Bajo un bloqueo consultivo por
   * (clínica, sede, usuario, día de la sede) se suman sus devoluciones del día
   * en esta moneda (de cualquier paciente) y, si con esta pasan del tope,
   * `DailyRefundCapExceededError`. El bloqueo dura hasta el COMMIT, que es
   * cuando la devolución nueva entra en la suma de la siguiente. El día sale
   * del reloj inyectado, leído TRAS esperar el bloqueo (ver
   * `lockDailyRefundDay`); el `createdAt` lo fija el trigger del servidor
   * (DX-226, `now()` de la BD al abrir la transacción) y no admite otro valor.
   */
  private async assertDailyRefundCap(
    tx: Tx,
    tenantId: string,
    locationId: string,
    timeZone: string,
    input: CreateRefundInput,
    cap: { capCents: number; clock: () => Date },
  ): Promise<void> {
    const { window } = await lockDailyRefundDay(
      tx,
      { tenantId, locationId, userId: input.userId },
      timeZone,
      cap.clock,
    );
    const total = await tx.patientCreditRefund.aggregate({
      where: {
        tenantId,
        locationId,
        createdById: input.userId,
        currency: input.currency,
        createdAt: { gte: window.start, lt: window.end },
      },
      _sum: { amount: true },
    });
    const usedCents = toCents(total._sum.amount?.toNumber() ?? 0);
    if (usedCents + input.amountCents > cap.capCents) {
      throw new DailyRefundCapExceededError(
        dailyRefundRemainingCents(cap.capCents, usedCents),
        input.currency,
        locationId,
      );
    }
  }

  /** 400 si, sin sede en la cabecera, el miembro podría escribir en varias. */
  private async assertSingleWriteLocation(tx: Tx): Promise<void> {
    const allowed = this.tenantContext.scopeLocationIds();
    const usable = await tx.location.count({
      where: {
        tenantId: this.tenantId(),
        isActive: true,
        deletedAt: null,
        ...(allowed ? { id: { in: allowed } } : {}),
      },
    });
    if (usable > 1) {
      throw new BadRequestException(CREDIT_CASH_LOCATION_REQUIRED_MESSAGE);
    }
  }

  async getRefund(id: string): Promise<CreditRefundRecord | null> {
    const tenantId = this.tenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      tx.patientCreditRefund.findFirst({
        where: { tenantId, id },
        select: REFUND_SELECT,
      }),
    );
    return row ? toRefund(row) : null;
  }

  listByPatient(patientId: string): Promise<PatientCreditMovements | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(
      async (tx) => {
        const patient = await tx.patient.findFirst({
          where: { tenantId, id: patientId, deletedAt: null },
          select: { id: true },
        });
        if (!patient) return null;
        const [transfers, refunds] = await Promise.all([
          tx.patientCreditTransfer.findMany({
            where: { tenantId, patientId },
            select: TRANSFER_SELECT,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          }),
          tx.patientCreditRefund.findMany({
            where: { tenantId, patientId },
            select: REFUND_SELECT,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          }),
        ]);
        // DX-432: el nombre de quien traspasó, por su membresía (RLS y
        // `tenantId`); sin filtrar `deletedAt`: si dejó la clínica, el
        // traspaso sigue siendo suyo.
        const authorIds = [...new Set(transfers.map((t) => t.createdById))];
        const authors =
          authorIds.length === 0
            ? []
            : await tx.clinicMembership.findMany({
                where: { tenantId, userId: { in: authorIds } },
                select: { userId: true, user: { select: { fullName: true } } },
              });
        const nameOf = new Map(authors.map((m) => [m.userId, m.user.fullName]));
        return {
          transfers: transfers.map((t) => ({
            ...toTransfer(t),
            createdByName: nameOf.get(t.createdById) ?? null,
          })),
          refunds: refunds.map(toRefund),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
