import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { prismaRuleCode } from '../../../../shared/prisma/prisma-exception.filter';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  loadLocationTimeZones,
  resolveLocationTimeZones,
} from '../../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../../shared/time/civil-day';
import type {
  ExpenseAttachment,
  ExpenseDetail,
  ExpensePayment,
} from '../../domain/entities/expense.entity';
import { categoryKey } from '../../domain/expense-categories';
import {
  ATTACHMENT_ALREADY_MESSAGE,
  EXPENSE_ALREADY_VOIDED_MESSAGE,
  EXPENSE_NOT_FOUND_MESSAGE,
  EXPENSE_VOIDED_MESSAGE,
  IDEMPOTENCY_KEY_REUSED_MESSAGE,
  ExpenseRuleError,
  FROM_CASH_METHOD_MESSAGE,
  LOCATION_INVALID_MESSAGE,
  OPEN_CASH_SESSION_REQUIRED_MESSAGE,
  PAYMENT_ALREADY_VOIDED_MESSAGE,
  PAYMENT_NOT_FOUND_MESSAGE,
  expenseEditDenial,
  paymentCapDenial,
  toCents,
  validateDueDate,
} from '../../domain/expense-rules';
import type { ExpenseCashLink } from '../../domain/ports/expense-cash-link.port';
import type {
  CreateExpensePaymentRepoInput,
  CreateExpenseRepoInput,
  ExpenseList,
  ExpenseListFilters,
  ExpenseRepository,
  IdempotentWrite,
  SupplierSuggestion,
  UpdateExpenseRepoInput,
} from '../../domain/ports/expense-repository.port';
import {
  type ExpenseListRow,
  countQuery,
  pageQuery,
} from './expense-list-query';
import {
  coreOfRow,
  dateOfDay,
  dayOf,
  mapDetail,
  mapExpense,
  mapPayment,
} from './expense-mappers';

/**
 * ¿Es un P2002 (violación de único)? Para los únicos PARCIALES de idempotencia
 * Prisma no informa `meta.target`: quien lo usa relee por la clave y, si no
 * encuentra la fila original, relanza el error tal cual.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * Una salida de caja que la BD rechaza (la red de la caja tomada con `FOR
 * SHARE`; no debería pasar): el trigger (caja no abierta o de otra sede,
 * 42501), la FK (23503) o el CHECK «con caja ⇒ efectivo» (23514), en español
 * y como 409/400, nunca un 500.
 */
function cashRejection(error: unknown): ExpenseRuleError | null {
  switch (prismaRuleCode(error)) {
    case '42501':
    case '23503':
      return new ExpenseRuleError(
        OPEN_CASH_SESSION_REQUIRED_MESSAGE,
        'CONFLICT',
      );
    case '23514':
      return new ExpenseRuleError(FROM_CASH_METHOD_MESSAGE, 'INVALID');
    default:
      return null;
  }
}

const notFound = () =>
  new ExpenseRuleError(EXPENSE_NOT_FOUND_MESSAGE, 'NOT_FOUND');
/** La clave ya se usó para algo que esta sede no ve: 409 en español, no un 500. */
const keyUsedElsewhere = () =>
  new ExpenseRuleError(IDEMPOTENCY_KEY_REUSED_MESSAGE, 'CONFLICT');
const conflict = (message: string) => new ExpenseRuleError(message, 'CONFLICT');

interface LockedExpense {
  id: string;
  locationId: string;
  currency: string;
  amountCents: bigint;
  voidedAt: Date | null;
}

@Injectable()
export class PrismaExpenseRepository implements ExpenseRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  // --- Sede, ajustes y nombres ----------------------------------------------
  resolveLocation(
    requested: string | undefined,
    now: Date,
  ): Promise<{ locationId: string; today: string }> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      let locationId: string;
      if (requested) {
        this.tenantContext.assertLocationAllowed(requested);
        const location = await tx.location.findFirst({
          where: { tenantId, id: requested, isActive: true, deletedAt: null },
          select: { id: true },
        });
        if (!location) {
          throw new ExpenseRuleError(LOCATION_INVALID_MESSAGE, 'INVALID');
        }
        locationId = location.id;
      } else {
        locationId = await this.tenantContext.writeLocationId(tx);
      }
      const zoneOf = await resolveLocationTimeZones(tx, tenantId, [locationId]);
      return { locationId, today: civilDateIn(now, zoneOf(locationId)) };
    });
  }

  locationToday(locationId: string, now: Date): Promise<string> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const zoneOf = await resolveLocationTimeZones(tx, tenantId, [locationId]);
      return civilDateIn(now, zoneOf(locationId));
    });
  }

  async cashRequiresOpenSession(): Promise<boolean> {
    const tenantId = this.requireTenantId();
    const tenant = await this.prisma.runWithTenant((tx) =>
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: { cashRequireOpenSession: true },
      }),
    );
    return tenant?.cashRequireOpenSession ?? false;
  }

  async locationNames(): Promise<Map<string, string>> {
    const tenantId = this.requireTenantId();
    const locations = await this.prisma.runWithTenant((tx) =>
      tx.location.findMany({
        where: { tenantId },
        select: { id: true, name: true },
      }),
    );
    return new Map(locations.map((l) => [l.id, l.name]));
  }

  async userNames(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const users = await this.prisma.runWithTenant((tx) =>
      tx.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, fullName: true },
      }),
    );
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  // --- Lecturas ---------------------------------------------------------------
  async list(
    filters: ExpenseListFilters,
    now: Date,
    withTotal = true,
  ): Promise<ExpenseList> {
    const tenantId = this.requireTenantId();
    const scope = this.tenantContext.scopeLocationIds();
    // Una sede pedida fuera de las visibles no devuelve nada (ni la delata).
    if (
      filters.locationId &&
      scope !== undefined &&
      !scope.includes(filters.locationId)
    ) {
      return {
        items: [],
        total: 0,
        page: filters.page,
        pageSize: filters.pageSize,
      };
    }
    return this.prisma.runWithTenant(async (tx) => {
      const zones = await loadLocationTimeZones(tx, tenantId);
      const ids = [...zones.keys()];
      const days = ids.map((id) => civilDateIn(now, zones.get(id)!));
      const args = { tenantId, filters, scope, todays: { ids, days } };
      // En orden: una transacción interactiva usa una sola conexión.
      const rows = await tx.$queryRaw<ExpenseListRow[]>(pageQuery(args));
      const [count] = withTotal
        ? await tx.$queryRaw<{ total: number }[]>(countQuery(args))
        : [];
      const todayOf = new Map(ids.map((id, i) => [id, days[i]]));
      const items = rows.map((row) =>
        mapExpense(
          { ...row, amountCents: Number(row.amountCents) },
          Number(row.paidCents),
          todayOf.get(row.locationId) ?? civilDateIn(now, 'UTC'),
        ),
      );
      return {
        items,
        total: count?.total ?? rows.length,
        page: filters.page,
        pageSize: filters.pageSize,
      };
    });
  }

  findById(id: string, now: Date): Promise<ExpenseDetail | null> {
    return this.prisma.runWithTenant((tx) => this.detailIn(tx, id, now));
  }

  /** Gasto con sus pagos si está en una sede visible; `null` si no. */
  private async detailIn(
    tx: Prisma.TransactionClient,
    id: string,
    now: Date,
  ): Promise<ExpenseDetail | null> {
    const row = await tx.expense.findFirst({
      where: {
        tenantId: this.requireTenantId(),
        id,
        ...this.tenantContext.locationScope(),
      },
      include: { payments: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
    if (!row) return null;
    const zoneOf = await resolveLocationTimeZones(tx, this.requireTenantId(), [
      row.locationId,
    ]);
    return mapDetail(row, civilDateIn(now, zoneOf(row.locationId)));
  }

  private async requireDetail(
    tx: Prisma.TransactionClient,
    id: string,
    now: Date,
  ): Promise<ExpenseDetail> {
    const detail = await this.detailIn(tx, id, now);
    if (!detail) throw notFound();
    return detail;
  }

  findByIdempotencyKey(
    key: string,
    now: Date,
  ): Promise<{ detail: ExpenseDetail; fingerprint: string | null } | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // Por clínica, no por sede: la clave ya usada con otra sede no puede
      // llegar a un INSERT que chocaría con el único (500).
      const row = await tx.expense.findFirst({
        where: { tenantId: this.requireTenantId(), idempotencyKey: key },
        select: { id: true, idempotencyFingerprint: true },
      });
      if (!row) return null;
      const detail = await this.detailIn(tx, row.id, now);
      if (!detail) throw keyUsedElsewhere();
      return { detail, fingerprint: row.idempotencyFingerprint };
    });
  }

  /**
   * El pago creado con esta clave (por clínica, no por sede). Si está en una
   * sede que el usuario no ve: 409 en español, nunca un 500 ni su contenido.
   */
  private async storedPaymentIn(
    tx: Prisma.TransactionClient,
    key: string,
  ): Promise<{ expenseId: string; fingerprint: string | null } | null> {
    const tenantId = this.requireTenantId();
    const row = await tx.expensePayment.findFirst({
      where: { tenantId, idempotencyKey: key },
      select: { expenseId: true, idempotencyFingerprint: true },
    });
    if (!row) return null;
    const visible = await tx.expense.count({
      where: {
        tenantId,
        id: row.expenseId,
        ...this.tenantContext.locationScope(),
      },
    });
    if (visible === 0) throw keyUsedElsewhere();
    return {
      expenseId: row.expenseId,
      fingerprint: row.idempotencyFingerprint,
    };
  }

  /** La respuesta original de un pago repetido con la misma clave, si la hay. */
  private async paymentReplayIn(
    tx: Prisma.TransactionClient,
    key: string,
    now: Date,
  ): Promise<IdempotentWrite | null> {
    const stored = await this.storedPaymentIn(tx, key);
    if (!stored) return null;
    return {
      detail: await this.requireDetail(tx, stored.expenseId, now),
      created: false,
      fingerprint: stored.fingerprint,
    };
  }

  findPaymentByIdempotencyKey(
    key: string,
  ): Promise<{ expenseId: string; fingerprint: string | null } | null> {
    return this.prisma.runWithTenant((tx) => this.storedPaymentIn(tx, key));
  }

  async suppliers(query: string, limit: number): Promise<SupplierSuggestion[]> {
    const tenantId = this.requireTenantId();
    const scope = this.tenantContext.scopeLocationIds();
    const scopeSql =
      scope === undefined
        ? Prisma.empty
        : Prisma.sql`AND "locationId" = ANY(${scope}::uuid[])`;
    const key = categoryKey(query);
    const rows = await this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<{ name: string }[]>`
        SELECT s."name" FROM (
          SELECT DISTINCT ON (u."key") u."supplier" AS "name", u."createdAt"
            FROM (
              SELECT "supplier", "createdAt",
                     public.dx_search_normalize("supplier") AS "key"
                FROM "expenses"
               WHERE "tenantId" = ${tenantId}::uuid
                 AND "supplier" IS NOT NULL
                 ${scopeSql}
            ) u
           WHERE position(${key} in u."key") > 0
           ORDER BY u."key", u."createdAt" DESC
        ) s
        ORDER BY s."createdAt" DESC, s."name"
        LIMIT ${limit}`,
    );
    return rows.map((r) => ({ name: r.name }));
  }

  async attachmentKeyInUse(key: string): Promise<boolean> {
    const count = await this.prisma.runWithTenant((tx) =>
      tx.expense.count({
        where: { tenantId: this.requireTenantId(), attachmentKey: key },
      }),
    );
    return count > 0;
  }

  // --- Escrituras -------------------------------------------------------------
  /**
   * Bloquea la fila del gasto (`FOR UPDATE`) si está en una sede visible: toda
   * escritura que depende de lo pagado (tope, edición, anulación) la toma, así
   * que dos a la vez se serializan y la segunda ve lo que dejó la primera.
   */
  private async lockExpense(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<LockedExpense> {
    const tenantId = this.requireTenantId();
    const scope = this.tenantContext.scopeLocationIds();
    const scopeSql =
      scope === undefined
        ? Prisma.empty
        : Prisma.sql`AND "locationId" = ANY(${scope}::uuid[])`;
    const rows = await tx.$queryRaw<LockedExpense[]>`
      SELECT "id", "locationId", "currency",
             ("amount" * 100)::bigint AS "amountCents", "voidedAt"
        FROM "expenses"
       WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${id}::uuid ${scopeSql}
       FOR UPDATE`;
    if (rows.length === 0) throw notFound();
    return rows[0];
  }

  /** Σ de pagos vivos y nº de pagos (vivos o anulados), en céntimos. */
  private async paymentTotals(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<{ liveCents: number; paymentCount: number }> {
    const [row] = await tx.$queryRaw<{ live: bigint; total: bigint }[]>`
      SELECT COALESCE(SUM(ROUND("amount" * 100)) FILTER (WHERE "voidedAt" IS NULL), 0)::bigint AS "live",
             COUNT(*)::bigint AS "total"
        FROM "expense_payments"
       WHERE "tenantId" = ${this.requireTenantId()}::uuid
         AND "expenseId" = ${id}::uuid`;
    return {
      liveCents: Number(row?.live ?? 0),
      paymentCount: Number(row?.total ?? 0),
    };
  }

  private async insertPayment(
    tx: Prisma.TransactionClient,
    expense: { id: string; locationId: string; currency: string },
    input: CreateExpensePaymentRepoInput,
  ): Promise<void> {
    const tenantId = this.requireTenantId();
    const cashSessionId = input.cashLink
      ? await input.cashLink.attachToOpenSession(tx, {
          tenantId,
          locationId: expense.locationId,
          userId: input.createdById,
        })
      : null;
    try {
      await tx.expensePayment.create({
        data: {
          tenantId,
          expenseId: expense.id,
          locationId: expense.locationId,
          currency: expense.currency,
          amount: input.amount,
          method: input.method,
          paidOn: dateOfDay(input.paidOn),
          cashSessionId,
          createdById: input.createdById,
          idempotencyKey: input.idempotencyKey ?? null,
          idempotencyFingerprint: input.idempotencyFingerprint ?? null,
        },
      });
    } catch (error) {
      // Solo una salida de caja se traduce; lo demás sigue su camino.
      throw (cashSessionId && cashRejection(error)) || error;
    }
  }

  async create(
    input: CreateExpenseRepoInput,
    payment: CreateExpensePaymentRepoInput | undefined,
    now: Date,
  ): Promise<IdempotentWrite> {
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const row = await tx.expense.create({
          data: {
            tenantId: this.requireTenantId(),
            locationId: input.locationId,
            category: input.category,
            supplier: input.supplier,
            description: input.description,
            amount: input.amount,
            currency: input.currency,
            invoiceDate: dateOfDay(input.invoiceDate),
            dueDate: input.dueDate ? dateOfDay(input.dueDate) : null,
            attachmentKey: input.attachment?.key ?? null,
            attachmentMime: input.attachment?.mime ?? null,
            attachmentSize: input.attachment?.size ?? null,
            attachmentSha256: input.attachment?.sha256 ?? null,
            attachmentName: input.attachment?.name ?? null,
            createdById: input.createdById,
            idempotencyKey: input.idempotencyKey ?? null,
            idempotencyFingerprint: input.idempotencyFingerprint ?? null,
          },
        });
        if (payment) await this.insertPayment(tx, coreOfRow(row), payment);
        return {
          detail: await this.requireDetail(tx, row.id, now),
          created: true,
          fingerprint: input.idempotencyFingerprint ?? null,
        };
      });
    } catch (error) {
      // Dos altas SIMULTÁNEAS con la misma Idempotency-Key pasan las dos el
      // atajo del caso de uso; la segunda choca con el único parcial. El
      // contrato promete devolver el original, no un 409.
      if (input.idempotencyKey && isUniqueViolation(error)) {
        const original = await this.findByIdempotencyKey(
          input.idempotencyKey,
          now,
        );
        if (original) {
          return {
            detail: original.detail,
            created: false,
            fingerprint: original.fingerprint,
          };
        }
      }
      throw error;
    }
  }

  update(
    id: string,
    patch: UpdateExpenseRepoInput,
    now: Date,
  ): Promise<ExpenseDetail> {
    return this.prisma.runWithTenant(async (tx) => {
      const locked = await this.lockExpense(tx, id);
      const tenantId = this.requireTenantId();
      const current = await tx.expense.findUniqueOrThrow({
        where: { id, tenantId },
      });
      const totals = await this.paymentTotals(tx, id);
      const denial = expenseEditDenial({
        current: {
          amountCents: Number(locked.amountCents),
          locationId: locked.locationId,
          currency: locked.currency,
          voided: locked.voidedAt !== null,
        },
        patch: {
          amountCents:
            patch.amount !== undefined ? toCents(patch.amount) : undefined,
          locationId: patch.locationId,
          currency: patch.currency,
        },
        liveCents: totals.liveCents,
        paymentCount: totals.paymentCount,
        currency: locked.currency,
      });
      if (denial) throw denial;
      // El vencimiento contra la fecha de factura que quedará (el CHECK de la
      // BD es la red).
      const invoiceDate = patch.invoiceDate ?? dayOf(current.invoiceDate);
      const dueDate =
        patch.dueDate !== undefined
          ? patch.dueDate
          : current.dueDate
            ? dayOf(current.dueDate)
            : null;
      validateDueDate(dueDate, invoiceDate);
      await tx.expense.update({
        where: { id, tenantId },
        data: {
          category: patch.category,
          supplier: patch.supplier,
          description: patch.description,
          amount: patch.amount,
          currency: patch.currency,
          locationId: patch.locationId,
          invoiceDate:
            patch.invoiceDate !== undefined
              ? dateOfDay(patch.invoiceDate)
              : undefined,
          dueDate:
            patch.dueDate === undefined
              ? undefined
              : patch.dueDate === null
                ? null
                : dateOfDay(patch.dueDate),
        },
      });
      return this.requireDetail(tx, id, now);
    });
  }

  /** Anula un pago vivo y deja que la caja resuelva su efecto (R5). */
  private async voidOnePayment(
    tx: Prisma.TransactionClient,
    paymentId: string,
    reason: string,
    by: string,
    now: Date,
    cashLink: ExpenseCashLink | undefined,
  ): Promise<ExpensePayment> {
    const voided = mapPayment(
      await tx.expensePayment.update({
        where: { id: paymentId, tenantId: this.requireTenantId() },
        // La BD fija la hora del servidor (trigger); `now` es solo el valor
        // que exige el CHECK de anulación completa.
        data: { voidedAt: now, voidedById: by, voidReason: reason },
      }),
    );
    if (voided.cashSessionId) {
      if (!cashLink) {
        // Un pago con caja se anula SIEMPRE con su CashLink: sin él el
        // arqueo quedaría restando una salida que ya no existe.
        throw new Error('Un pago con caja se anula con su CashLink (R5)');
      }
      await cashLink.onPaymentVoided(tx, voided, reason, by);
    }
    return voided;
  }

  void(
    id: string,
    reason: string,
    by: string,
    now: Date,
    cashLink?: ExpenseCashLink,
  ): Promise<ExpenseDetail> {
    return this.prisma.runWithTenant(async (tx) => {
      const locked = await this.lockExpense(tx, id);
      if (locked.voidedAt) throw conflict(EXPENSE_ALREADY_VOIDED_MESSAGE);
      const tenantId = this.requireTenantId();
      const live = await tx.expensePayment.findMany({
        where: { tenantId, expenseId: id, voidedAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      for (const payment of live) {
        await this.voidOnePayment(tx, payment.id, reason, by, now, cashLink);
      }
      await tx.expense.update({
        where: { id, tenantId },
        data: { voidedAt: now, voidedById: by, voidReason: reason },
      });
      return this.requireDetail(tx, id, now);
    });
  }

  async addPayment(
    expenseId: string,
    input: CreateExpensePaymentRepoInput,
    now: Date,
  ): Promise<IdempotentWrite> {
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const locked = await this.lockExpense(tx, expenseId);
        // Con el gasto bloqueado: si otra petición con la misma clave ya
        // pagó (p. ej. el doble clic en «pagar todo»), esa es la respuesta,
        // no un 400 del tope.
        const replay = input.idempotencyKey
          ? await this.paymentReplayIn(tx, input.idempotencyKey, now)
          : null;
        if (replay) return replay;
        if (locked.voidedAt) throw conflict(EXPENSE_VOIDED_MESSAGE);
        const { liveCents } = await this.paymentTotals(tx, expenseId);
        const denial = paymentCapDenial({
          amountCents: Number(locked.amountCents),
          liveCents,
          paymentCents: toCents(input.amount),
          currency: locked.currency,
        });
        if (denial) throw denial;
        await this.insertPayment(tx, locked, input);
        return {
          detail: await this.requireDetail(tx, expenseId, now),
          created: true,
          fingerprint: input.idempotencyFingerprint ?? null,
        };
      });
    } catch (error) {
      if (input.idempotencyKey && isUniqueViolation(error)) {
        const key = input.idempotencyKey;
        const replay = await this.prisma.runWithTenant((tx) =>
          this.paymentReplayIn(tx, key, now),
        );
        if (replay) return replay;
      }
      throw error;
    }
  }

  voidPayment(
    expenseId: string,
    paymentId: string,
    reason: string,
    by: string,
    now: Date,
    cashLink?: ExpenseCashLink,
  ): Promise<ExpenseDetail> {
    return this.prisma.runWithTenant(async (tx) => {
      await this.lockExpense(tx, expenseId);
      const payment = await tx.expensePayment.findFirst({
        where: { tenantId: this.requireTenantId(), id: paymentId, expenseId },
        select: { id: true, voidedAt: true },
      });
      if (!payment) {
        throw new ExpenseRuleError(PAYMENT_NOT_FOUND_MESSAGE, 'NOT_FOUND');
      }
      if (payment.voidedAt) throw conflict(PAYMENT_ALREADY_VOIDED_MESSAGE);
      await this.voidOnePayment(tx, paymentId, reason, by, now, cashLink);
      return this.requireDetail(tx, expenseId, now);
    });
  }

  attach(
    id: string,
    attachment: ExpenseAttachment,
    now: Date,
  ): Promise<ExpenseDetail> {
    return this.prisma.runWithTenant(async (tx) => {
      const locked = await this.lockExpense(tx, id);
      if (locked.voidedAt) throw conflict(EXPENSE_VOIDED_MESSAGE);
      // La fila está bloqueada: o no tiene soporte y lo fija esta petición, o
      // lo tiene (otra se adelantó) y es un 409. El trigger de la BD es la red.
      const { count } = await tx.expense.updateMany({
        where: { tenantId: this.requireTenantId(), id, attachmentKey: null },
        data: {
          attachmentKey: attachment.key,
          attachmentMime: attachment.mime,
          attachmentSize: attachment.size,
          attachmentSha256: attachment.sha256,
          attachmentName: attachment.name,
        },
      });
      if (count === 0) throw conflict(ATTACHMENT_ALREADY_MESSAGE);
      return this.requireDetail(tx, id, now);
    });
  }
}
