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
import { resolveLocationTimeZones } from '../../../shared/locations/location-time-zone';
import { lockOpenSessionOf } from '../../cash-sessions/infrastructure/payment-cash-session';
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
  const { payments, seriesPrefix, number, snapshot, ...rest } = row;
  return {
    ...rest,
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
             COALESCE((
               SELECT pg_catalog.sum(p."amount") FROM "payments" p
                WHERE p."tenantId" = tp."tenantId" AND p."treatmentPlanId" = tp."id"
                  AND p."currency" = tp."currency" AND p."deletedAt" IS NULL
             ), 0)::text AS "paid",
             COALESCE((
               SELECT pg_catalog.sum(e."amount") FROM "patient_credit_entries" e
                WHERE e."tenantId" = tp."tenantId" AND e."treatmentPlanId" = tp."id"
                  AND e."currency" = tp."currency"
             ), 0)::text AS "entries"
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

  async updateReceptionCap(cents: number): Promise<number> {
    const tenantId = this.tenantId();
    const tenant = await this.prisma.runWithTenant((tx) =>
      tx.tenant.update({
        where: { id: tenantId },
        data: {
          creditReceptionMaxAmount: new Prisma.Decimal(fromCents(cents)),
        },
        select: { creditReceptionMaxAmount: true },
      }),
    );
    return toCents(tenant.creditReceptionMaxAmount.toNumber());
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
        if (!source || source.creditCents < input.amountCents) {
          throw new ConflictException(CREDIT_CHANGED_MESSAGE);
        }
        // El destino se pudo cancelar o rechazar entre la lectura del caso de
        // uso y el bloqueo: se relee bajo el bloqueo (el cambio de estado
        // espera a este COMMIT o ya está confirmado).
        const target = await this.planCredit(tx, tenantId, input.targetPlanId);
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
        const plan = await this.planCredit(tx, tenantId, input.planId);
        if (!plan || plan.creditCents < input.amountCents) {
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
        // DX-378: el comprobante pinta fechas y horas en la zona de la sede.
        const timeZone = (
          await resolveLocationTimeZones(tx, tenantId, [location.id])
        )(location.id);
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
        return {
          transfers: transfers.map(toTransfer),
          refunds: refunds.map(toRefund),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
