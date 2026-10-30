import { Injectable } from '@nestjs/common';
import { Prisma, type CashSessionStatus } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  firstLocationWithRows,
  loadPeriodLocationZones,
  resolveLocationTimeZones,
  type LocationZones,
} from '../../../shared/locations/location-time-zone';
import { civilDateIn, civilPeriodByZone } from '../../../shared/time/civil-day';
import { formatReceiptNumber } from '../../payments/domain/receipt-number';
import {
  ARQUEO_METHODS,
  centsOf,
  expectedLines,
  fromCents,
  type ArqueoSource,
} from '../domain/arqueo';
import type {
  CashAdjustmentView,
  CashClosingView,
  CashExpectedLine,
  CashOutflow,
  CashSessionPayment,
  CashSessionSummary,
  CashSettings,
  CashVoidedOutflow,
  CashVoidedPayment,
  MoneyAmount,
  StaffRef,
} from '../domain/cash-session.entity';
import type {
  CashSessionRecord,
  CashSessionRepository,
  CashSessionScope,
  CloseContext,
  CloseOutcome,
  ClosingDraft,
  CorrectionData,
  CorrectionOutcome,
  ListCashSessionsParams,
  OpenCashSessionData,
  ReopenOutcome,
} from '../domain/ports/cash-session-repository.port';
import {
  lockCashAdjustmentAssignment,
  lockOpenSessionOf,
} from './payment-cash-session';

type Tx = Prisma.TransactionClient;

const SUMMARY_SELECT = {
  id: true,
  status: true,
  locationId: true,
  openedById: true,
  openedAt: true,
  closedAt: true,
  closedById: true,
  reopenCount: true,
  notes: true,
  location: { select: { id: true, name: true } },
  floats: {
    select: { currency: true, amount: true },
    orderBy: { currency: 'asc' },
  },
  closings: {
    select: {
      sequence: true,
      lines: { select: { currency: true, difference: true } },
    },
    orderBy: { sequence: 'desc' },
    take: 1,
  },
} satisfies Prisma.CashSessionSelect;

type SummaryRow = Prisma.CashSessionGetPayload<{
  select: typeof SUMMARY_SELECT;
}>;

const PAYMENT_SELECT = {
  id: true,
  paidAt: true,
  amount: true,
  currency: true,
  method: true,
  createdById: true,
  deletedAt: true,
  voidedAt: true,
  voidedById: true,
  voidReason: true,
  receipt: { select: { seriesPrefix: true, number: true } },
  // DX-390: una línea 2..N de un cobro dividido lleva el recibo de su línea 1.
  splitHead: {
    select: { receipt: { select: { seriesPrefix: true, number: true } } },
  },
  // El paciente sale del plan o, en un abono contra un saldo migrado
  // (DX-262), del saldo.
  plan: {
    select: {
      patient: { select: { id: true, firstName: true, lastName: true } },
    },
  },
  openingBalance: {
    select: {
      patient: { select: { id: true, firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.PaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

/** Paciente del abono: el del plan o el del saldo migrado (CHECK de payments). */
function patientOf(row: PaymentRow): { id: string; fullName: string } {
  const patient = row.plan?.patient ?? row.openingBalance?.patient;
  if (!patient) throw new Error(`Abono ${row.id} sin plan ni saldo migrado`);
  return {
    id: patient.id,
    fullName: `${patient.firstName} ${patient.lastName}`,
  };
}

const ADJUSTMENT_SELECT = {
  id: true,
  kind: true,
  currency: true,
  method: true,
  amount: true,
  reason: true,
  createdAt: true,
  createdById: true,
  sessionId: true,
  payment: { select: PAYMENT_SELECT },
  expensePayment: {
    select: {
      id: true,
      expenseId: true,
      expense: { select: { category: true, supplier: true } },
    },
  },
  originalSession: {
    select: { id: true, openedAt: true, openedById: true },
  },
} satisfies Prisma.CashSessionAdjustmentSelect;

type AdjustmentRow = Prisma.CashSessionAdjustmentGetPayload<{
  select: typeof ADJUSTMENT_SELECT;
}>;

/** Una salida de caja menor (DX-274): pago de gasto desde el cajón. */
const OUTFLOW_SELECT = {
  id: true,
  expenseId: true,
  amount: true,
  currency: true,
  createdAt: true,
  createdById: true,
  voidedAt: true,
  voidedById: true,
  voidReason: true,
  expense: { select: { category: true, supplier: true } },
} satisfies Prisma.ExpensePaymentSelect;

type OutflowRow = Prisma.ExpensePaymentGetPayload<{
  select: typeof OUTFLOW_SELECT;
}>;

const CLOSING_SELECT = {
  id: true,
  sequence: true,
  closedAt: true,
  closedById: true,
  blind: true,
  hasDifference: true,
  differenceReason: true,
  notes: true,
  suggestedLockDate: true,
  lines: {
    select: {
      currency: true,
      method: true,
      opening: true,
      expected: true,
      counted: true,
      difference: true,
    },
  },
} satisfies Prisma.CashSessionClosingSelect;

type ClosingRow = Prisma.CashSessionClosingGetPayload<{
  select: typeof CLOSING_SELECT;
}>;

/** DATE de Postgres -> día civil (Prisma lo trae a medianoche UTC). */
const civilOf = (date: Date): string => date.toISOString().slice(0, 10);

const amountOf = (value: Prisma.Decimal): number => value.toNumber();

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * Los abonos que cuentan en el arqueo de una caja: los suyos activos y los
 * que se anularon con la caja ya cerrada (esa anulación es un ajuste VOID en
 * otra caja, así que aquí siguen contando: la caja cerrada no cambia, tampoco
 * si un ADMIN la reabre y se vuelve a cerrar).
 */
const countedPayments = (sessionId: string): Prisma.PaymentWhereInput => ({
  cashSessionId: sessionId,
  OR: [
    { deletedAt: null },
    {
      cashAdjustments: {
        some: { kind: 'VOID', originalSessionId: sessionId },
      },
    },
  ],
});

/**
 * Las salidas de caja menor (DX-274) que restan en el arqueo de una caja, con
 * la misma regla que `countedPayments`: las vivas y las anuladas con la caja
 * ya cerrada (su anulación es un ajuste OUTFLOW_VOID en otra caja). La caja
 * lee `expense_payments` directamente: no depende del módulo de gastos.
 */
const countedOutflows = (
  sessionId: string,
): Prisma.ExpensePaymentWhereInput => ({
  cashSessionId: sessionId,
  OR: [
    { voidedAt: null },
    {
      cashAdjustments: {
        some: { kind: 'OUTFLOW_VOID', originalSessionId: sessionId },
      },
    },
  ],
});

/**
 * Caja por turno (DX-027). Todo con `runWithTenant` (RLS FORCE) y `tenantId`
 * explícito; los nombres del personal y las zonas de las sedes se resuelven
 * en consultas fijas (sin N+1). La inmutabilidad la garantiza la BD
 * (triggers de 20261018140200_dx027_cash_sessions); aquí solo se escriben las
 * transiciones con su fila.
 */
@Injectable()
export class PrismaCashSessionRepository implements CashSessionRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  // ---------------------------------------------------------------------
  // Ajustes, sedes y monedas
  // ---------------------------------------------------------------------

  async getSettings(): Promise<CashSettings> {
    // `tenants` es global (sin RLS): siempre por el id del contexto.
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.tenantId() },
      select: { cashRequireOpenSession: true, cashBlindClose: true },
    });
    return {
      requireOpenSession: tenant.cashRequireOpenSession,
      blindClose: tenant.cashBlindClose,
    };
  }

  async updateSettings(settings: CashSettings): Promise<CashSettings> {
    const tenant = await this.prisma.tenant.update({
      where: { id: this.tenantId() },
      data: {
        cashRequireOpenSession: settings.requireOpenSession,
        cashBlindClose: settings.blindClose,
      },
      select: { cashRequireOpenSession: true, cashBlindClose: true },
    });
    return {
      requireOpenSession: tenant.cashRequireOpenSession,
      blindClose: tenant.cashBlindClose,
    };
  }

  resolveLocation(locationId?: string): Promise<string | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // DX-089: sin sede pedida, la de escritura de la sesión (la principal
      // sin restricción, la primera permitida con ella).
      if (!locationId) return this.tenantContext.writeLocationId(tx);
      const row = await tx.location.findFirst({
        where: { id: locationId, tenantId, deletedAt: null },
        select: { id: true },
      });
      return row?.id ?? null;
    });
  }

  async missingCurrencies(codes: readonly string[]): Promise<string[]> {
    const found = await this.prisma.currency.findMany({
      where: { code: { in: [...codes] } },
      select: { code: true },
    });
    const known = new Set(found.map((c) => c.code));
    return codes.filter((code) => !known.has(code));
  }

  // ---------------------------------------------------------------------
  // Abrir
  // ---------------------------------------------------------------------

  async open(
    data: OpenCashSessionData,
  ): Promise<{ id: string } | 'ALREADY_OPEN'> {
    const tenantId = this.tenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        await lockCashAdjustmentAssignment(tx, tenantId, data.locationId);
        const session = await tx.cashSession.create({
          data: {
            tenantId,
            locationId: data.locationId,
            openedById: data.openedById,
            notes: data.notes,
          },
          select: { id: true },
        });
        if (data.floats.length > 0) {
          await tx.cashSessionFloat.createMany({
            data: data.floats.map((float) => ({
              tenantId,
              sessionId: session.id,
              currency: float.currency,
              amount: new Prisma.Decimal(fromCents(float.cents)),
            })),
          });
        }
        // Lo que quedó pendiente en la sede (anulaciones o abonos tardíos de
        // quien no tenía caja abierta) entra en esta, la siguiente que se abre.
        await tx.cashSessionAdjustment.updateMany({
          where: { tenantId, locationId: data.locationId, sessionId: null },
          data: { sessionId: session.id },
        });
        return session;
      });
    } catch (error) {
      // cash_sessions_open_key: ya tiene una abierta en la sede.
      if (isUniqueViolation(error)) return 'ALREADY_OPEN';
      throw error;
    }
  }

  async findOpenId(locationId: string, userId: string): Promise<string | null> {
    const tenantId = this.tenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      tx.cashSession.findFirst({
        where: { tenantId, locationId, openedById: userId, status: 'OPEN' },
        select: { id: true },
      }),
    );
    return row?.id ?? null;
  }

  // ---------------------------------------------------------------------
  // Listar
  // ---------------------------------------------------------------------

  list(
    params: ListCashSessionsParams,
  ): Promise<{ items: CashSessionSummary[]; total: number }> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(
      async (tx) => {
        const zones = await loadPeriodLocationZones(
          tx,
          tenantId,
          params.locationIds,
          firstLocationWithRows(tx.cashSession, tenantId),
        );
        const where: Prisma.CashSessionWhereInput = {
          tenantId,
          ...(params.openedById ? { openedById: params.openedById } : {}),
          ...(params.locationIds
            ? { locationId: { in: [...params.locationIds] } }
            : {}),
          ...(params.status ? { status: params.status } : {}),
          ...this.periodWhere(params, zones),
        };
        // Los índices (tenantId[, locationId | openedById], openedAt DESC, id
        // DESC) sirven el orden y el filtro de cada combinación.
        const [rows, total] = await Promise.all([
          tx.cashSession.findMany({
            where,
            select: SUMMARY_SELECT,
            orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
            skip: params.skip,
            take: params.take,
          }),
          tx.cashSession.count({ where }),
        ]);
        const names = await this.staffNames(
          tx,
          rows.flatMap((r) => [r.openedById, r.closedById ?? r.openedById]),
        );
        return {
          items: rows.map((row) =>
            this.toSummary(row, names, zones.zoneOf(row.locationId)),
          ),
          total,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /** Días civiles de apertura, cortados en la zona de cada sede (DX-097). */
  private periodWhere(
    params: ListCashSessionsParams,
    zones: LocationZones,
  ): Prisma.CashSessionWhereInput {
    if (!params.from && !params.to) return {};
    const from = params.from ?? params.to!;
    const to = params.to ?? params.from!;
    const branches = civilPeriodByZone(from, to, zones.configured);
    if (branches.length === 0) return { id: { in: [] } };
    return {
      OR: branches.map((b) => ({
        locationId: { in: b.locationIds },
        openedAt: { gte: b.start, lt: b.end },
      })),
    };
  }

  // ---------------------------------------------------------------------
  // Detalle
  // ---------------------------------------------------------------------

  detail(
    id: string,
    scope: CashSessionScope,
  ): Promise<CashSessionRecord | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(
      async (tx) => {
        const session = await tx.cashSession.findFirst({
          where: { id, tenantId, ...scope },
          select: SUMMARY_SELECT,
        });
        if (!session) return null;
        const [
          source,
          payments,
          outflows,
          adjustments,
          later,
          closings,
          reopenings,
        ] = await Promise.all([
          this.arqueoSource(tx, tenantId, id),
          tx.payment.findMany({
            where: { tenantId, cashSessionId: id },
            select: {
              ...PAYMENT_SELECT,
              cashAdjustments: {
                where: { kind: 'VOID', originalSessionId: id },
                select: { id: true },
              },
            },
            orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          }),
          tx.expensePayment.findMany({
            where: { tenantId, cashSessionId: id },
            select: {
              ...OUTFLOW_SELECT,
              cashAdjustments: {
                where: { kind: 'OUTFLOW_VOID', originalSessionId: id },
                select: { id: true },
              },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          }),
          tx.cashSessionAdjustment.findMany({
            where: { tenantId, sessionId: id },
            select: ADJUSTMENT_SELECT,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          }),
          tx.cashSessionAdjustment.findMany({
            where: { tenantId, originalSessionId: id },
            select: ADJUSTMENT_SELECT,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          }),
          tx.cashSessionClosing.findMany({
            where: { tenantId, sessionId: id },
            select: CLOSING_SELECT,
            orderBy: { sequence: 'desc' },
          }),
          tx.cashSessionReopening.findMany({
            where: { tenantId, sessionId: id },
            orderBy: { sequence: 'desc' },
          }),
        ]);
        const timeZone = (
          await resolveLocationTimeZones(tx, tenantId, [session.locationId])
        )(session.locationId);
        const names = await this.staffNames(tx, [
          session.openedById,
          ...(session.closedById ? [session.closedById] : []),
          ...payments.flatMap((p) => [p.createdById, p.voidedById]),
          ...outflows.flatMap((o) => [o.createdById, o.voidedById]),
          ...[...adjustments, ...later].flatMap((a) => [
            a.createdById,
            a.originalSession?.openedById,
          ]),
          ...closings.map((c) => c.closedById),
          ...reopenings.map((r) => r.reopenedById),
        ]);

        const active = payments.filter((p) => p.deletedAt === null);
        const liveOutflows = outflows.filter((o) => o.voidedAt === null);
        const voidedOutflows = outflows.filter((o) => o.voidedAt !== null);
        const voided = payments.filter((p) => p.deletedAt !== null);
        const closingViews = closings.map((c) => this.toClosing(c, names));
        return {
          ...this.toSummary(session, names, timeZone),
          notes: session.notes,
          timeZone,
          expected: expectedLines(source).map((line): CashExpectedLine => ({
            currency: line.currency,
            method: line.method,
            opening: fromCents(line.openingCents),
            payments: fromCents(line.paymentsCents),
            paymentsCount: line.paymentsCount,
            adjustments: fromCents(line.adjustmentsCents),
            outflows: fromCents(line.outflowsCents),
            outflowsCount: line.outflowsCount,
            expected: fromCents(line.expectedCents),
          })),
          payments: active.map((p) => this.toPayment(p, names, timeZone)),
          voidedPayments: voided.map((p): CashVoidedPayment => ({
            ...this.toPayment(p, names, timeZone),
            voidedAt: p.voidedAt,
            voidedBy: p.voidedById ? this.staff(p.voidedById, names) : null,
            voidReason: p.voidReason,
            bookedAsAdjustment: p.cashAdjustments.length > 0,
          })),
          outflows: liveOutflows.map((o) => this.toOutflow(o, names)),
          voidedOutflows: voidedOutflows.map((o): CashVoidedOutflow => ({
            ...this.toOutflow(o, names),
            voidedAt: o.voidedAt,
            voidedBy: o.voidedById ? this.staff(o.voidedById, names) : null,
            voidReason: o.voidReason,
            bookedAsAdjustment: o.cashAdjustments.length > 0,
          })),
          adjustments: adjustments.map((a) =>
            this.toAdjustment(a, names, timeZone),
          ),
          laterAdjustments: later.map((a) =>
            this.toAdjustment(a, names, timeZone),
          ),
          closing:
            session.status === 'CLOSED' ? (closingViews[0] ?? null) : null,
          closings: closingViews,
          reopenings: reopenings.map((r) => ({
            id: r.id,
            sequence: r.sequence,
            reopenedAt: r.reopenedAt,
            reopenedBy: this.staff(r.reopenedById, names),
            reason: r.reason,
          })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /** Fondo, abonos que cuentan, ajustes y salidas de la caja, en céntimos. */
  private async arqueoSource(
    tx: Tx,
    tenantId: string,
    sessionId: string,
  ): Promise<ArqueoSource> {
    const [floats, payments, adjustments, outflows] = await Promise.all([
      tx.cashSessionFloat.findMany({
        where: { tenantId, sessionId },
        select: { currency: true, amount: true },
      }),
      tx.payment.findMany({
        where: { tenantId, ...countedPayments(sessionId) },
        select: { currency: true, method: true, amount: true },
      }),
      tx.cashSessionAdjustment.findMany({
        where: { tenantId, sessionId },
        select: { currency: true, method: true, amount: true },
      }),
      // El CHECK de la BD garantiza que un pago con caja es en efectivo.
      tx.expensePayment.findMany({
        where: { tenantId, ...countedOutflows(sessionId) },
        select: { currency: true, amount: true },
      }),
    ]);
    const cents = (value: Prisma.Decimal) => centsOf(value.toNumber());
    return {
      floats: floats.map((f) => ({
        currency: f.currency,
        cents: cents(f.amount),
      })),
      payments: payments.map((p) => ({
        currency: p.currency,
        method: p.method,
        cents: cents(p.amount),
      })),
      adjustments: adjustments.map((a) => ({
        currency: a.currency,
        method: a.method,
        cents: cents(a.amount),
      })),
      outflows: outflows.map((o) => ({
        currency: o.currency,
        cents: cents(o.amount),
      })),
    };
  }

  // ---------------------------------------------------------------------
  // Cerrar y reabrir
  // ---------------------------------------------------------------------

  /** La caja bloqueada (FOR UPDATE) si la ve quien actúa. */
  private async lockSession(
    tx: Tx,
    tenantId: string,
    id: string,
    scope: CashSessionScope,
  ) {
    const onlyOpener = scope.openedById
      ? Prisma.sql`AND "openedById" = ${scope.openedById}::uuid`
      : Prisma.empty;
    const [row] = await tx.$queryRaw<
      {
        id: string;
        locationId: string;
        openedById: string;
        status: CashSessionStatus;
        reopenCount: number;
      }[]
    >`
      SELECT "id", "locationId", "openedById", "status"::text AS "status", "reopenCount"
        FROM "cash_sessions"
       WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${id}::uuid
         ${onlyOpener}
       FOR UPDATE`;
    return row ?? null;
  }

  close(
    id: string,
    scope: CashSessionScope,
    closedById: string,
    decide: (context: CloseContext) => ClosingDraft,
  ): Promise<CloseOutcome> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const session = await this.lockSession(tx, tenantId, id, scope);
      if (!session) return 'NOT_FOUND';
      if (session.status !== 'OPEN') return 'NOT_OPEN';

      // Con la caja bloqueada: ningún abono ni salida de caja menor puede
      // entrar ni anularse sin esperar a este COMMIT (ver
      // payment-cash-session.ts y expense-cash-session.ts).
      const [source, timeZoneOf, settings] = await Promise.all([
        this.arqueoSource(tx, tenantId, id),
        resolveLocationTimeZones(tx, tenantId, [session.locationId]),
        tx.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          select: { cashBlindClose: true },
        }),
      ]);
      const draft = decide({
        locationId: session.locationId,
        openedById: session.openedById,
        timeZone: timeZoneOf(session.locationId),
        blind: settings.cashBlindClose,
        expected: expectedLines(source),
      });

      const closing = await tx.cashSessionClosing.create({
        data: {
          tenantId,
          sessionId: id,
          sequence: session.reopenCount + 1,
          closedById,
          blind: draft.blind,
          hasDifference: draft.hasDifference,
          differenceReason: draft.differenceReason,
          notes: draft.notes,
          suggestedLockDate: new Date(
            `${draft.suggestedLockDate}T00:00:00.000Z`,
          ),
        },
        select: { id: true },
      });
      if (draft.lines.length > 0) {
        await tx.cashSessionClosingLine.createMany({
          data: draft.lines.map((line) => ({
            tenantId,
            closingId: closing.id,
            currency: line.currency,
            method: line.method,
            opening: new Prisma.Decimal(fromCents(line.openingCents)),
            expected: new Prisma.Decimal(fromCents(line.expectedCents)),
            counted: new Prisma.Decimal(fromCents(line.countedCents)),
            difference: new Prisma.Decimal(fromCents(line.differenceCents)),
          })),
        });
      }
      await tx.cashSession.update({
        where: { id },
        data: { status: 'CLOSED', closedById },
      });
      return 'CLOSED';
    });
  }

  async reopen(
    id: string,
    reopenedById: string,
    reason: string,
  ): Promise<ReopenOutcome> {
    const tenantId = this.tenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const session = await this.lockSession(tx, tenantId, id, {});
        if (!session) return 'NOT_FOUND';
        if (session.status !== 'CLOSED') return 'NOT_CLOSED';
        const sequence = session.reopenCount + 1;
        const closing = await tx.cashSessionClosing.findFirstOrThrow({
          where: { tenantId, sessionId: id, sequence },
          select: { id: true },
        });
        await tx.cashSessionReopening.create({
          data: {
            tenantId,
            sessionId: id,
            sequence,
            closingId: closing.id,
            reason,
            reopenedById,
          },
        });
        await tx.cashSession.update({
          where: { id },
          data: {
            status: 'OPEN',
            closedAt: null,
            closedById: null,
            reopenCount: sequence,
          },
        });
        return 'REOPENED';
      });
    } catch (error) {
      // cash_sessions_open_key: quien la abrió ya tiene otra abierta.
      if (isUniqueViolation(error)) return 'ALREADY_OPEN';
      throw error;
    }
  }

  addCorrection(id: string, data: CorrectionData): Promise<CorrectionOutcome> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const session = await this.lockSession(tx, tenantId, id, {});
      if (!session) return { kind: 'NOT_FOUND' };
      if (session.status !== 'CLOSED') return { kind: 'NOT_CLOSED' };
      const target = await lockOpenSessionOf(
        tx,
        tenantId,
        session.locationId,
        data.createdById,
      );
      const created = await tx.cashSessionAdjustment.create({
        data: {
          tenantId,
          locationId: session.locationId,
          sessionId: target,
          kind: 'CORRECTION',
          originalSessionId: id,
          currency: data.currency,
          method: data.method,
          amount: new Prisma.Decimal(fromCents(data.cents)),
          reason: data.reason,
          createdById: data.createdById,
        },
        select: ADJUSTMENT_SELECT,
      });
      const names = await this.staffNames(tx, [
        created.createdById,
        created.originalSession?.openedById,
      ]);
      const timeZone = (
        await resolveLocationTimeZones(tx, tenantId, [session.locationId])
      )(session.locationId);
      return {
        kind: 'CREATED',
        adjustment: this.toAdjustment(created, names, timeZone),
      };
    });
  }

  // ---------------------------------------------------------------------
  // Mapeo
  // ---------------------------------------------------------------------

  /** Nombre de cada miembro de la clínica (bajo RLS), en una consulta. */
  private async staffNames(
    tx: Tx,
    userIds: readonly (string | null | undefined)[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(userIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const members = await tx.clinicMembership.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, user: { select: { fullName: true } } },
    });
    return new Map(members.map((m) => [m.userId, m.user.fullName]));
  }

  private staff(id: string, names: Map<string, string>): StaffRef {
    return { id, fullName: names.get(id) ?? null };
  }

  private toSummary(
    row: SummaryRow,
    names: Map<string, string>,
    timeZone: string,
  ): CashSessionSummary {
    const latest = row.status === 'CLOSED' ? row.closings[0] : undefined;
    const differences = new Map<string, number>();
    for (const line of latest?.lines ?? []) {
      differences.set(
        line.currency,
        (differences.get(line.currency) ?? 0) +
          centsOf(amountOf(line.difference)),
      );
    }
    return {
      id: row.id,
      status: row.status,
      location: row.location,
      openedBy: this.staff(row.openedById, names),
      openedAt: row.openedAt,
      openedOn: civilDateIn(row.openedAt, timeZone),
      closedAt: row.closedAt,
      closedBy: row.closedById ? this.staff(row.closedById, names) : null,
      reopenCount: row.reopenCount,
      floats: row.floats.map((f): MoneyAmount => ({
        currency: f.currency,
        amount: amountOf(f.amount),
      })),
      differences: [...differences.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, cents]) => ({ currency, amount: fromCents(cents) })),
    };
  }

  private toPayment(
    row: PaymentRow,
    names: Map<string, string>,
    timeZone: string,
  ): CashSessionPayment {
    const receipt = row.receipt ?? row.splitHead?.receipt ?? null;
    return {
      id: row.id,
      paidAt: row.paidAt,
      paidOn: civilDateIn(row.paidAt, timeZone),
      amount: amountOf(row.amount),
      currency: row.currency,
      method: row.method,
      receiptNumber: receipt
        ? formatReceiptNumber(receipt.seriesPrefix, receipt.number)
        : null,
      patient: patientOf(row),
      createdBy: row.createdById ? this.staff(row.createdById, names) : null,
    };
  }

  private toOutflow(row: OutflowRow, names: Map<string, string>): CashOutflow {
    return {
      id: row.id,
      expenseId: row.expenseId,
      category: row.expense.category,
      supplier: row.expense.supplier,
      amount: amountOf(row.amount),
      currency: row.currency,
      createdAt: row.createdAt,
      createdBy: this.staff(row.createdById, names),
    };
  }

  private toAdjustment(
    row: AdjustmentRow,
    names: Map<string, string>,
    timeZone: string,
  ): CashAdjustmentView {
    const payment = row.payment
      ? this.toPayment(row.payment, names, timeZone)
      : null;
    return {
      id: row.id,
      kind: row.kind,
      currency: row.currency,
      method: row.method,
      amount: amountOf(row.amount),
      reason: row.reason,
      createdAt: row.createdAt,
      createdBy: this.staff(row.createdById, names),
      sessionId: row.sessionId,
      payment: payment
        ? {
            id: payment.id,
            patient: payment.patient,
            paidOn: payment.paidOn,
            receiptNumber: payment.receiptNumber,
          }
        : null,
      expensePayment: row.expensePayment
        ? {
            id: row.expensePayment.id,
            expenseId: row.expensePayment.expenseId,
            category: row.expensePayment.expense.category,
            supplier: row.expensePayment.expense.supplier,
          }
        : null,
      originalSession: row.originalSession
        ? {
            id: row.originalSession.id,
            openedAt: row.originalSession.openedAt,
            openedBy: this.staff(row.originalSession.openedById, names),
          }
        : null,
    };
  }

  private toClosing(
    row: ClosingRow,
    names: Map<string, string>,
  ): CashClosingView {
    return {
      id: row.id,
      sequence: row.sequence,
      closedAt: row.closedAt,
      closedBy: this.staff(row.closedById, names),
      blind: row.blind,
      hasDifference: row.hasDifference,
      differenceReason: row.differenceReason,
      notes: row.notes,
      suggestedLockDate: civilOf(row.suggestedLockDate),
      lines: [...row.lines]
        .sort(
          (a, b) =>
            a.currency.localeCompare(b.currency) ||
            ARQUEO_METHODS.indexOf(a.method) - ARQUEO_METHODS.indexOf(b.method),
        )
        .map((line) => ({
          currency: line.currency,
          method: line.method,
          opening: amountOf(line.opening),
          expected: amountOf(line.expected),
          counted: amountOf(line.counted),
          difference: amountOf(line.difference),
        })),
    };
  }
}
