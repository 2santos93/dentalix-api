import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, TreatmentPlanStatus } from '@prisma/client';
import {
  isPlanBillable,
  notBillableMessage,
} from '../../../treatment-plans/domain/plan-status-machine';
import {
  IDEMPOTENCY_KEY_REUSED_MESSAGE,
  isSameRequest,
  paymentTargetKey,
  type IdempotentPayment,
} from '../../domain/idempotency';
import {
  OPENING_BALANCE_NOT_FOUND_MESSAGE,
  openingBalanceCurrencyMessage,
  OPENING_BALANCE_PAID_MESSAGE,
  openingBalanceOverpaidMessage,
} from '../../domain/opening-balance-payment';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  firstLocationWithRows,
  loadPeriodLocationZones,
  resolveLocationTimeZones,
} from '../../../../shared/locations/location-time-zone';
import {
  civilDateIn,
  civilNoonIn,
  civilPeriodByZone,
} from '../../../../shared/time/civil-day';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { RegionalFormat } from '../../../../shared/format/regional-format';
import { requireLocationFormat } from '../../../../shared/locations/location-regional';
import {
  CashRegisterPage,
  CashRegisterRow,
  CivilPeriod,
  CreatePaymentRepoInput,
  ListCashRegisterParams,
  ListPaymentsReceivedInRangeParams,
  OpeningBalanceTarget,
  PaymentRepository,
  PaymentVoidAudit,
  PaymentVoidTarget,
  ReceivedPayment,
} from '../../domain/ports/payment-repository.port';
import { Payment } from '../../domain/entities/payment.entity';
import { exchangeRateStatus } from '../../domain/payment-exchange-rate';
import {
  frozenRateData,
  frozenRateOf,
  manualRatesStillMatch,
} from './frozen-exchange-rate.mapper';
import { CashPayment } from '../../domain/entities/cash-payment.entity';
import { formatReceiptNumber } from '../../domain/receipt-number';
import type { ReceiptPlanBalance } from '../../domain/receipt-snapshot';
import { issuePaymentReceipt } from '../receipts/issue-payment-receipt';
import {
  assignPaymentToCashSession,
  recordLatePaymentAdjustment,
  recordVoidAdjustment,
} from '../../../cash-sessions/infrastructure/payment-cash-session';
import { reopenPromiseOnVoid } from '../../../collections/infrastructure/prisma-collections.repository';
import {
  enqueuePlanRebalance,
  lockPaymentAllocations,
  removeVoidedAllocations,
} from '../allocations/prisma-plan-allocation.repository';

// DX-136: cada abono se lee con la serie y el número de su recibo (o sin
// recibo, si es anterior a la numeración).
const PAYMENT_INCLUDE = {
  receipt: { select: { seriesPrefix: true, number: true } },
} satisfies Prisma.PaymentInclude;

type PrismaPayment = Prisma.PaymentGetPayload<{
  include: typeof PAYMENT_INCLUDE;
}>;

/** El filtro de un período civil y la zona con que se leyó cada sede. */
interface PeriodScope {
  where: Prisma.PaymentWhereInput;
  timeZoneOf: (locationId: string) => string;
}

/**
 * ¿Es un P2002 (violación de único)? Para el único PARCIAL (tenantId,
 * idempotencyKey) Prisma no informa `meta.target` ("(not available)"), así que
 * no se puede distinguir por nombre; quien lo usa relee por la clave y, si no
 * encuentra el abono original, relanza el error tal cual.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function mapToEntity(payment: PrismaPayment, timeZone: string): Payment {
  return {
    id: payment.id,
    tenantId: payment.tenantId,
    treatmentPlanId: payment.treatmentPlanId,
    openingBalanceId: payment.openingBalanceId,
    patientId: payment.patientId,
    amount: payment.amount.toNumber(),
    currency: payment.currency,
    paidAt: payment.paidAt,
    paidOn: civilDateIn(payment.paidAt, timeZone),
    method: payment.method,
    notes: payment.notes,
    createdById: payment.createdById,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    receiptNumber: payment.receipt
      ? formatReceiptNumber(
          payment.receipt.seriesPrefix,
          payment.receipt.number,
        )
      : null,
    exchangeRateCurrency: payment.exchangeRateCurrency,
    frozenRate: frozenRateOf(payment),
    exchangeRateStatus: exchangeRateStatus({
      currency: payment.currency,
      exchangeRateCurrency: payment.exchangeRateCurrency,
      frozenRate: frozenRateOf(payment),
    }),
  };
}

// Lo que la caja lee de cada abono: el abono más paciente (vía su plan), plan y
// sede, en una sola `findMany` con `select` anidado — Prisma resuelve cada
// relación con UNA consulta por nivel para toda la página (`IN (...)`), nunca
// una por fila, así que el número de consultas no crece con la página.
const CASH_PAYMENT_SELECT = {
  id: true,
  createdById: true,
  // `createdAt` no se expone: solo alimenta la regla de anulación (canVoid).
  createdAt: true,
  paidAt: true,
  amount: true,
  currency: true,
  method: true,
  notes: true,
  location: { select: { id: true, name: true } },
  plan: {
    select: {
      id: true,
      status: true,
      createdAt: true,
      patient: { select: { id: true, firstName: true, lastName: true } },
    },
  },
  // DX-262: un abono contra un saldo migrado no tiene plan.
  openingBalance: {
    select: {
      id: true,
      concept: true,
      patient: { select: { id: true, firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.PaymentSelect;

type PrismaCashPayment = Prisma.PaymentGetPayload<{
  select: typeof CASH_PAYMENT_SELECT;
}>;

function mapToCashRow(
  row: PrismaCashPayment,
  timeZoneOf: (locationId: string) => string,
): CashRegisterRow {
  const timeZone = timeZoneOf(row.location.id);
  return {
    payment: mapToCashPayment(row, timeZone),
    voidSubject: {
      createdById: row.createdById,
      createdAt: row.createdAt,
      timeZone,
    },
  };
}

function mapToCashPayment(
  row: PrismaCashPayment,
  timeZone: string,
): CashPayment {
  return {
    id: row.id,
    createdById: row.createdById,
    paidAt: row.paidAt,
    paidOn: civilDateIn(row.paidAt, timeZone),
    amount: row.amount.toNumber(),
    currency: row.currency,
    method: row.method,
    notes: row.notes,
    location: { id: row.location.id, name: row.location.name },
    // `Payment.patientId` es la copia desnormalizada del paciente del plan (o
    // del saldo migrado, DX-262): las FK compuestas lo garantizan.
    patient: patientOfCashRow(row),
    treatmentPlan: row.plan
      ? {
          id: row.plan.id,
          status: row.plan.status,
          createdAt: row.plan.createdAt,
        }
      : null,
    openingBalance: row.openingBalance
      ? { id: row.openingBalance.id, concept: row.openingBalance.concept }
      : null,
  };
}

function patientOfCashRow(row: PrismaCashPayment): {
  id: string;
  fullName: string;
} {
  const patient = row.plan?.patient ?? row.openingBalance?.patient;
  if (!patient) {
    // payments_target_check: todo abono tiene plan o saldo migrado.
    throw new Error(`Abono ${row.id} sin plan ni saldo migrado`);
  }
  return {
    id: patient.id,
    fullName: `${patient.firstName} ${patient.lastName}`,
  };
}

@Injectable()
export class PrismaPaymentRepository implements PaymentRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `tenantId` is NOT NULL at the DB level with no column default that
   * autofills from the RLS GUC, so — unlike a plain SELECT/UPDATE, which RLS
   * filters transparently — an INSERT still needs the app to supply it
   * explicitly. We never take it from the input (never from the client); we
   * read it from the same request-scoped context that `runWithTenant(fn)`
   * uses to set `app.current_tenant`, so the value written always matches
   * the GUC the WITH CHECK policy validates against (same convention as
   * PrismaSaleRepository / PrismaTreatmentPlanRepository).
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  /**
   * DX-097: el período de días CIVILES (`from`..`to`, ambos inclusive) como
   * filtro de `paidAt` en la zona de CADA sede, leída de la BD en UNA consulta
   * (nunca del cliente). Con sede activa, un solo rango en su zona. Sin sede
   * (vista consolidada), una rama por ZONA con sus sedes —
   * `(locationId IN (...) AND paidAt >= a AND paidAt < b) OR ...`—, y si todas
   * las sedes comparten zona (lo normal), un único rango sin filtro de sede.
   * Así el número de ramas no crece con las sedes ni con las filas, y cada
   * rama la sirve payments_tenantId_locationId_paidAt_active_idx (o
   * payments_tenantId_paidAt_active_idx con una sola zona).
   */
  private async periodScope(
    tx: Prisma.TransactionClient,
    period: CivilPeriod,
  ): Promise<PeriodScope> {
    // DX-089: la sede del request o, sin ella, las permitidas al miembro
    // (`undefined` = sin restricción: todas las sedes de la clínica).
    const tenantId = this.requireTenantId();
    const scopeIds = this.tenantContext.scopeLocationIds();
    const zones = await loadPeriodLocationZones(
      tx,
      tenantId,
      scopeIds,
      firstLocationWithRows(tx.payment, tenantId),
    );
    const timeZoneOf = (id: string) => zones.zoneOf(id);
    let branches: ReturnType<typeof civilPeriodByZone>;
    try {
      branches = civilPeriodByZone(period.from, period.to, zones.configured);
    } catch (error) {
      // Un día que no existe en la zona de alguna sede (p. ej. 2011-12-30 en
      // Pacific/Apia): es la petición la que no vale, no un fallo del servidor.
      if (error instanceof RangeError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    const paidAtIn = (b: { start: Date; end: Date }) => ({
      gte: b.start,
      lt: b.end,
    });

    if (branches.length === 0) {
      // Sin sedes visibles no puede haber abonos (FK a la sede): nada casa.
      return { where: { id: { in: [] } }, timeZoneOf };
    }
    if (branches.length === 1) {
      // Una sola zona: un rango, acotado a las sedes del alcance si lo hay.
      const locationScope =
        scopeIds === undefined
          ? {}
          : scopeIds.length === 1
            ? { locationId: scopeIds[0] }
            : { locationId: { in: scopeIds } };
      return {
        where: { ...locationScope, paidAt: paidAtIn(branches[0]) },
        timeZoneOf,
      };
    }
    return {
      where: {
        OR: branches.map((b) => ({
          locationId: { in: b.locationIds },
          paidAt: paidAtIn(b),
        })),
      },
      timeZoneOf,
    };
  }

  /**
   * Abonos con su `paidOn` (DX-097): la zona de las sedes de TODAS las filas
   * en UNA consulta, en la misma transacción.
   */
  private async toEntities(
    tx: Prisma.TransactionClient,
    rows: PrismaPayment[],
  ): Promise<Payment[]> {
    if (rows.length === 0) return [];
    const zoneOf = await resolveLocationTimeZones(
      tx,
      this.requireTenantId(),
      rows.map((row) => row.locationId),
    );
    return rows.map((row) => mapToEntity(row, zoneOf(row.locationId)));
  }

  private async toEntity(
    tx: Prisma.TransactionClient,
    row: PrismaPayment | null,
  ): Promise<Payment | null> {
    if (!row) return null;
    const [entity] = await this.toEntities(tx, [row]);
    return entity;
  }

  async create(input: CreatePaymentRepoInput): Promise<Payment> {
    try {
      return await this.insert(input);
    } catch (error) {
      // DB-014: dos reintentos SIMULTÁNEOS con la misma Idempotency-Key pasan
      // los dos el atajo del caso de uso; el segundo INSERT espera al COMMIT
      // del primero y choca con el único parcial. El contrato de idempotencia
      // promete devolver el abono original, no un 409: se relee y se devuelve.
      if (input.idempotencyKey && isUniqueViolation(error)) {
        const original = await this.findByIdempotencyKey(input.idempotencyKey);
        if (original) {
          // DX-109: solo si es la MISMA petición (plan + cuerpo).
          if (
            input.requestFingerprint !== undefined &&
            !isSameRequest(
              original,
              paymentTargetKey({
                treatmentPlanId: input.treatmentPlanId,
                openingBalanceId: input.openingBalanceId ?? null,
              }),
              input.requestFingerprint,
            )
          ) {
            throw new UnprocessableEntityException(
              IDEMPOTENCY_KEY_REUSED_MESSAGE,
            );
          }
          return original.payment;
        }
      }
      throw error;
    }
  }

  private async insert(input: CreatePaymentRepoInput): Promise<Payment> {
    const tenantId = this.requireTenantId();
    const payment = await this.prisma.runWithTenant(async (tx) => {
      // DB-014: el plan se vuelve a validar DENTRO de la transacción del
      // INSERT, vivo y con el paciente del abono, y queda bloqueado en modo
      // compartido (FOR SHARE) hasta el COMMIT: nadie puede retirarlo entre la
      // comprobación y el alta. La FK compuesta no mira `deletedAt`.
      //
      // DX-109 (BE-013): en el MISMO SELECT bloqueante se lee el estado: un
      // plan rechazado o cancelado no admite abonos (409), y nadie puede
      // rechazarlo o cancelarlo entre esta lectura y el INSERT. COMPLETED sí.
      const targetBalance = input.openingBalanceId
        ? await this.lockOpeningBalance(tx, input)
        : null;
      // DX-051: la moneda del plan bloqueado, la de la base del abono.
      const planCurrency = input.openingBalanceId
        ? null
        : await this.lockPlan(tx, input);
      // Sede del request si el cliente la fijó (X-Location-Id, ya validada
      // contra esta clínica); si no, la de escritura de la sesión: la sede por
      // defecto sin restricción (lo de siempre) o la primera permitida
      // (DX-089).
      const locationId = await this.tenantContext.writeLocationId(tx);
      // DX-097: un pago con solo el día se guarda al mediodía de ESA sede, así
      // cae en su día de caja (medianoche UTC sería la tarde del día anterior
      // en Bogotá).
      const timeZone = (
        await resolveLocationTimeZones(tx, tenantId, [locationId])
      )(locationId);
      const paidAt =
        input.paidAt instanceof Date
          ? input.paidAt
          : civilNoonIn(input.paidAt.civilDate, timeZone);
      // DX-027: la caja abierta de quien cobra en esta sede (bloqueada hasta
      // el COMMIT); sin caja, 409 si la clínica exige caja para el efectivo.
      // DX-375: la moneda de destino es la del plan bloqueado (o la del saldo
      // migrado, que es la del abono). La tasa cotizada fuera se congela solo
      // si sigue valiendo aquí; si no, el abono queda «sin tasa» y sin base.
      const targetCurrency = planCurrency ?? input.currency;
      const frozen = input.frozenRate;
      const freeze =
        frozen !== null &&
        frozen.currency === targetCurrency &&
        frozen.date === civilDateIn(paidAt, timeZone) &&
        (await manualRatesStillMatch(tx, tenantId, input.currency, frozen))
          ? frozen
          : null;
      const cash = await assignPaymentToCashSession(tx, {
        tenantId,
        locationId,
        userId: input.createdById,
        method: input.method,
        paidAt,
        timeZone,
        now: new Date(),
      });
      const created = await tx.payment.create({
        data: {
          locationId,
          tenantId,
          cashSessionId: cash.cashSessionId,
          treatmentPlanId: input.treatmentPlanId,
          openingBalanceId: input.openingBalanceId ?? null,
          patientId: input.patientId,
          amount: input.amount,
          currency: input.currency,
          paidAt,
          method: input.method,
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
          idempotencyFingerprint: input.requestFingerprint,
          createdById: input.createdById,
          exchangeRateCurrency: targetCurrency,
          ...(freeze ? frozenRateData(freeze) : {}),
        },
      });
      // DX-027: con fecha de un día cuya caja ya cerró, es un ajuste de la
      // caja abierta (o pendiente), con enlace a la cerrada.
      if (cash.late && created.createdById) {
        await recordLatePaymentAdjustment(
          tx,
          { ...created, createdById: created.createdById },
          cash.late,
        );
      }
      const entity = mapToEntity({ ...created, receipt: null }, timeZone);
      // DX-051 (R4): la base del abono nace con él si se convirtió a la moneda
      // que el plan tiene con su fila bloqueada y con el día civil con que se
      // guardó; el plan queda encolado y el reparto corre tras el COMMIT. Si
      // no, el barrido la crea después (R9.3).
      const planAmount = input.planAmount;
      if (
        planAmount &&
        created.treatmentPlanId &&
        planAmount.planCurrency === planCurrency &&
        planAmount.rateDate === entity.paidOn &&
        // DX-375: la base sale de la tasa congelada; sin ella, tampoco base.
        (input.currency === planCurrency || freeze !== null)
      ) {
        await tx.paymentPlanAmount.create({
          data: {
            paymentId: created.id,
            tenantId,
            treatmentPlanId: created.treatmentPlanId,
            amount: planAmount.amount,
            currency: planAmount.planCurrency,
            rateDate: new Date(`${planAmount.rateDate}T00:00:00.000Z`),
          },
          select: { paymentId: true },
        });
        await enqueuePlanRebalance(tx, tenantId, created.treatmentPlanId);
      }
      // DX-136: el recibo numerado nace en la MISMA transacción que el abono.
      const receiptNumber = await issuePaymentReceipt(
        tx,
        {
          id: created.id,
          tenantId,
          locationId,
          treatmentPlanId: created.treatmentPlanId,
          openingBalanceId: created.openingBalanceId,
          patientId: created.patientId,
          amount: entity.amount,
          currency: created.currency,
          method: created.method,
          paidAt: created.paidAt,
          paidOn: entity.paidOn,
          createdById: created.createdById,
        },
        // Revisión DX-375: el saldo del recibo salió de la tasa cotizada
        // fuera; si aquí ya no vale, el abono queda «sin tasa» y el saldo no
        // lo cuenta, así que el recibo sale sin saldo (como sin tasa).
        targetBalance ??
          (frozen !== null && freeze === null
            ? null
            : input.receiptPlanBalance),
      );
      return { ...entity, receiptNumber };
    });
    return payment;
  }

  /**
   * DB-014 / DX-109: el plan se vuelve a validar DENTRO de la transacción del
   * INSERT, vivo y con el paciente del abono, y queda bloqueado en modo
   * compartido (FOR SHARE) hasta el COMMIT: nadie puede retirarlo entre la
   * comprobación y el alta (la FK compuesta no mira `deletedAt`). En el MISMO
   * SELECT se lee el estado: un plan rechazado o cancelado no admite abonos
   * (409). COMPLETED sí. Devuelve la moneda del plan (DX-051: la de la base).
   */
  private async lockPlan(
    tx: Prisma.TransactionClient,
    input: CreatePaymentRepoInput,
  ): Promise<string> {
    const [plan] = await tx.$queryRaw<
      { id: string; status: TreatmentPlanStatus; currency: string }[]
    >`
      SELECT "id", "status", "currency" FROM "treatment_plans"
       WHERE "id" = ${input.treatmentPlanId}::uuid
         AND "patientId" = ${input.patientId}::uuid
         AND "deletedAt" IS NULL
       FOR SHARE`;
    if (!plan) {
      throw new NotFoundException('Treatment plan not found');
    }
    if (!isPlanBillable(plan.status)) {
      throw new ConflictException(notBillableMessage(plan.status));
    }
    return plan.currency;
  }

  /**
   * DX-262: el saldo migrado del abono, vivo y del paciente, bloqueado FOR
   * UPDATE hasta el COMMIT (dos abonos simultáneos al mismo saldo se ponen en
   * fila y el segundo ve el primero), en su moneda y sin pasarse de lo
   * pendiente (400). Devuelve el saldo tras el abono para el recibo.
   */
  private async lockOpeningBalance(
    tx: Prisma.TransactionClient,
    input: CreatePaymentRepoInput,
  ): Promise<ReceiptPlanBalance> {
    const tenantId = this.requireTenantId();
    const [balance] = await tx.$queryRaw<
      { amount: Prisma.Decimal; currency: string; locationId: string }[]
    >`
      SELECT "amount", "currency", "locationId" FROM "opening_balances"
       WHERE "tenantId" = ${tenantId}::uuid
         AND "id" = ${input.openingBalanceId}::uuid
         AND "patientId" = ${input.patientId}::uuid
         AND "voidedAt" IS NULL
       FOR UPDATE`;
    if (!balance) {
      throw new NotFoundException(OPENING_BALANCE_NOT_FOUND_MESSAGE);
    }
    if (balance.currency !== input.currency) {
      throw new BadRequestException(
        openingBalanceCurrencyMessage(balance.currency),
      );
    }
    const [{ paid }] = await tx.$queryRaw<{ paid: Prisma.Decimal | null }[]>`
      SELECT sum("amount") AS "paid" FROM "payments"
       WHERE "tenantId" = ${tenantId}::uuid
         AND "openingBalanceId" = ${input.openingBalanceId}::uuid
         AND "currency" = ${balance.currency}
         AND "deletedAt" IS NULL`;
    const amountCents = Math.round(balance.amount.toNumber() * 100);
    const paidCents = Math.round((paid?.toNumber() ?? 0) * 100);
    const pendingCents = amountCents - paidCents;
    const thisCents = Math.round(input.amount * 100);
    if (thisCents > pendingCents) {
      throw new BadRequestException(
        pendingCents <= 0
          ? OPENING_BALANCE_PAID_MESSAGE
          : openingBalanceOverpaidMessage(
              pendingCents / 100,
              balance.currency,
              await this.locationFormatIn(tx, balance.locationId),
            ),
      );
    }
    return {
      currency: balance.currency,
      billable: amountCents / 100,
      paid: (paidCents + thisCents) / 100,
      balance: (pendingCents - thisCents) / 100,
    };
  }

  locationFormat(locationId: string): Promise<RegionalFormat> {
    return this.prisma.runWithTenant((tx) =>
      this.locationFormatIn(tx, locationId),
    );
  }

  /** G1-B: formato de una sede (la del dato, R12), solo para pintar (I4). */
  private async locationFormatIn(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<RegionalFormat> {
    const location = await tx.location.findFirst({
      where: { id, tenantId: this.requireTenantId() },
      select: { locale: true, hourCycle: true },
    });
    return requireLocationFormat({
      id,
      locale: location?.locale ?? null,
      hourCycle: location?.hourCycle ?? null,
    });
  }

  async resolvePaidOn(paidAt: Date | { civilDate: string }): Promise<string> {
    if (!(paidAt instanceof Date)) return paidAt.civilDate;
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // La misma sede que usará `insert`.
      const locationId = await this.tenantContext.writeLocationId(tx);
      const timeZone = (
        await resolveLocationTimeZones(tx, tenantId, [locationId])
      )(locationId);
      return civilDateIn(paidAt, timeZone);
    });
  }

  async findById(id: string): Promise<Payment | null> {
    return this.prisma.runWithTenant(async (tx) =>
      this.toEntity(
        tx,
        await tx.payment.findFirst({
          where: { id, deletedAt: null },
          include: PAYMENT_INCLUDE,
        }),
      ),
    );
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<IdempotentPayment | null> {
    // RLS (runWithTenant) scopes this to the current tenant, matching the
    // (tenantId, idempotencyKey) unique index. NOT filtered by `deletedAt`: a
    // replay must resolve to the SAME row even if it was later voided, so we
    // never insert a duplicate for a key that already exists.
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.payment.findFirst({
        where: { idempotencyKey },
        include: PAYMENT_INCLUDE,
      });
      const payment = await this.toEntity(tx, row);
      if (!row || !payment) return null;
      return { payment, requestFingerprint: row.idempotencyFingerprint };
    });
  }

  // OJO: listByPlan/listByPatient NO filtran por sede a propósito. El plan y
  // el paciente son de la CLÍNICA, no de una sede; filtrarlos haría que el
  // saldo del paciente cambiara según desde qué sede se mire, que es
  // justamente lo contrario de la "ficha centralizada" que define este modelo.
  async listByPlan(treatmentPlanId: string): Promise<Payment[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const payments = await tx.payment.findMany({
        where: { treatmentPlanId, deletedAt: null },
        include: PAYMENT_INCLUDE,
        orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      });
      return this.toEntities(tx, payments);
    });
  }

  async findOpeningBalance(id: string): Promise<OpeningBalanceTarget | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const balance = await tx.openingBalance.findFirst({
        where: { id, tenantId, voidedAt: null },
        select: {
          id: true,
          patientId: true,
          currency: true,
          amount: true,
          locationId: true,
        },
      });
      if (!balance) return null;
      const paid = await tx.payment.aggregate({
        where: {
          tenantId,
          openingBalanceId: id,
          currency: balance.currency,
          deletedAt: null,
        },
        _sum: { amount: true },
      });
      return {
        id: balance.id,
        patientId: balance.patientId,
        currency: balance.currency,
        amount: balance.amount.toNumber(),
        paid: paid._sum.amount?.toNumber() ?? 0,
        locationId: balance.locationId,
      };
    });
  }

  async listByOpeningBalance(openingBalanceId: string): Promise<Payment[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const payments = await tx.payment.findMany({
        where: { openingBalanceId, deletedAt: null },
        include: PAYMENT_INCLUDE,
        orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      });
      return this.toEntities(tx, payments);
    });
  }

  async listByPatient(patientId: string): Promise<Payment[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const payments = await tx.payment.findMany({
        where: { patientId, deletedAt: null },
        include: PAYMENT_INCLUDE,
        orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      });
      return this.toEntities(tx, payments);
    });
  }

  async findVoidTarget(id: string): Promise<PaymentVoidTarget | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const payment = await tx.payment.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          createdById: true,
          createdAt: true,
          locationId: true,
        },
      });
      if (!payment) {
        return null;
      }
      // "Hoy" es el día civil de la sede del abono (su horario), nunca el
      // UTC del servidor; ver `resolveLocationTimeZones`.
      const timeZoneOf = await resolveLocationTimeZones(
        tx,
        this.requireTenantId(),
        [payment.locationId],
      );
      return {
        id: payment.id,
        createdById: payment.createdById,
        createdAt: payment.createdAt,
        timeZone: timeZoneOf(payment.locationId),
      };
    });
  }

  async softDelete(id: string, audit: PaymentVoidAudit): Promise<boolean> {
    // Single atomic UPDATE ... WHERE id = ? AND deletedAt IS NULL (RLS
    // additionally scopes it to the current tenant) instead of a
    // findFirst-then-update pair -- that sequence let two concurrent voids
    // of the same payment both pass the "not yet voided" check (TOCTOU
    // race), since `update({ where: { id } })` alone never re-checked
    // `deletedAt`. `count` tells the caller, in one round trip, whether
    // THIS call actually voided the row. The audit (who/when/why, SEC-013)
    // goes in the SAME statement, so a voided row never lacks it.
    return this.prisma.runWithTenant(async (tx) => {
      const tenantId = this.requireTenantId();
      // DX-051 (R12, pre-flight C1): plan FOR SHARE, la fila del abono, su
      // base FOR UPDATE y los ítems de sus imputaciones ANTES de anularlo. Un reparto
      // concurrente o espera a esta anulación (y al leer la liveness tras su
      // bloqueo ya lo ve anulado) o termina antes (y el DELETE de abajo borra
      // lo que imputó).
      const planId = await lockPaymentAllocations(tx, tenantId, id);
      const result = await tx.payment.updateMany({
        where: { id, deletedAt: null },
        data: {
          deletedAt: audit.voidedAt,
          voidedAt: audit.voidedAt,
          voidedById: audit.voidedById,
          voidReason: audit.reason,
        },
      });
      if (result.count === 0) return false;
      if (planId) await removeVoidedAllocations(tx, tenantId, id, planId);
      // DX-027: si contaba en una caja ya cerrada, la anulación es un ajuste
      // en la caja abierta de quien anula (la cerrada no cambia).
      await recordVoidAdjustment(tx, {
        tenantId: this.requireTenantId(),
        paymentId: id,
        voidedById: audit.voidedById,
      });
      // DX-215 (BE-032): cada compromiso de pago CUMPLIDO del paciente en
      // su moneda para el que contaba este abono, si ya no queda cubierto, vuelve a OPEN (o
      // BROKEN pasada su fecha), auditado, en esta misma transacción.
      await reopenPromiseOnVoid(tx, {
        tenantId: this.requireTenantId(),
        paymentId: id,
        now: audit.voidedAt,
        actor: { userId: audit.voidedById, role: audit.voidedByRole },
        locationId: audit.request?.locationId ?? null,
        requestId: audit.request?.requestId ?? null,
        ip: audit.request?.ip ?? null,
        userAgent: audit.request?.userAgent ?? null,
      });
      // DX-136: el recibo conserva su número y queda marcado ANULADO con la
      // misma fecha, autor y motivo, en la misma transacción. Los abonos
      // anteriores a la numeración no tienen recibo (0 filas).
      await tx.paymentReceipt.updateMany({
        where: { paymentId: id, voidedAt: null },
        data: {
          voidedAt: audit.voidedAt,
          voidedById: audit.voidedById,
          voidReason: audit.reason,
        },
      });
      return true;
    });
  }

  async listReceivedInRange(
    params: ListPaymentsReceivedInRangeParams,
  ): Promise<ReceivedPayment[]> {
    // La CAJA del período sí es por sede (es lo que se arquea): `periodScope`
    // filtra por la sede activa si la hay.
    return this.prisma.runWithTenant(
      async (tx) => {
        const scope = await this.periodScope(tx, params);
        const payments = await tx.payment.findMany({
          where: { deletedAt: null, ...scope.where },
          include: PAYMENT_INCLUDE,
          orderBy: { paidAt: 'desc' },
        });
        return payments.map((payment) =>
          mapToEntity(payment, scope.timeZoneOf(payment.locationId)),
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async listForCashRegister(
    params: ListCashRegisterParams,
  ): Promise<CashRegisterPage> {
    const locationId = this.tenantContext.getLocationId();

    return this.prisma.runWithTenant(
      async (tx) => {
        // La caja es por sede, igual que listReceivedInRange: es lo que se
        // arquea. El período se corta en la zona de cada sede (DX-097), leída
        // en esta misma foto; ver `periodScope` para los índices que la sirven.
        const scope = await this.periodScope(tx, params);
        const where: Prisma.PaymentWhereInput = {
          deletedAt: null,
          ...scope.where,
          ...(params.method ? { method: params.method } : {}),
        };

        // Página, conteo, agregado y sede en la MISMA transacción REPEATABLE
        // READ: todas las sentencias ven la misma foto, así que un abono
        // registrado o anulado a mitad de camino no puede dejar un total que
        // describa otras filas que las devueltas (en READ COMMITTED, el nivel
        // por defecto, cada sentencia vería su propia foto).
        const [rows, total, groups, scopeLocation] = await Promise.all([
          tx.payment.findMany({
            where,
            select: CASH_PAYMENT_SELECT,
            // Varios abonos pueden compartir `paidAt` (los registrados solo
            // con fecha caen al mediodía de la sede): sin un desempate estable
            // la paginación podría repetir o saltarse filas entre páginas.
            // Desempate por alta y luego por id: dentro de un día, los
            // registrados solo con fecha comparten el mediodía (DX-097).
            orderBy: [
              { paidAt: 'desc' },
              { createdAt: 'desc' },
              { id: 'desc' },
            ],
            skip: params.skip,
            take: params.take,
          }),
          tx.payment.count({ where }),
          tx.payment.groupBy({
            by: ['currency', 'method'],
            where,
            _sum: { amount: true },
            _count: { _all: true },
            orderBy: [{ currency: 'asc' }, { method: 'asc' }],
          }),
          locationId
            ? tx.location.findFirst({
                // El interceptor ya la validó (activa y de esta clínica); se
                // repite el filtro para que una sede retirada entre la
                // validación y esta lectura no reaparezca como alcance.
                where: { id: locationId, deletedAt: null },
                select: { id: true, name: true },
              })
            : Promise.resolve(null),
        ]);

        // La zona de cada sede ya se leyó para el período, en la misma foto:
        // el `canVoid` de cada fila usa el mismo "hoy" que la anulación.
        return {
          items: rows.map((row) => mapToCashRow(row, scope.timeZoneOf)),
          total,
          groups: groups.map((group) => ({
            currency: group.currency,
            method: group.method,
            total: group._sum.amount?.toNumber() ?? 0,
            count: group._count._all,
          })),
          scopeLocation,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
