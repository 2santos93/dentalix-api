import { randomUUID } from 'node:crypto';
import type { ExpenseCategory } from '../../domain/entities/expense-category.entity';
import type {
  Expense,
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
  ExpenseRuleError,
  LOCATION_INVALID_MESSAGE,
  PAYMENT_ALREADY_VOIDED_MESSAGE,
  PAYMENT_NOT_FOUND_MESSAGE,
  expenseEditDenial,
  expenseStatus,
  fromCents,
  paymentCapDenial,
  toCents,
  validateDueDate,
} from '../../domain/expense-rules';
import type { ExpenseCashLink } from '../../domain/ports/expense-cash-link.port';
import type { ExpenseCategoryRepository } from '../../domain/ports/expense-category-repository.port';
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

export const TENANT_ID = '11111111-1111-4111-8111-111111111111';
export const LOCATION_ID = '22222222-2222-4222-8222-222222222222';
export const OTHER_LOCATION_ID = '33333333-3333-4333-8333-333333333333';
export const USER_ID = '44444444-4444-4444-8444-444444444444';

interface StoredPayment extends ExpensePayment {
  idempotencyKey: string | null;
  idempotencyFingerprint: string | null;
}

interface StoredExpense {
  id: string;
  locationId: string;
  category: string;
  supplier: string | null;
  description: string | null;
  amount: number;
  currency: string;
  invoiceDate: string;
  dueDate: string | null;
  attachment: ExpenseAttachment | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  voidedAt: Date | null;
  voidedById: string | null;
  voidReason: string | null;
  idempotencyKey: string | null;
  idempotencyFingerprint: string | null;
}

const rule = (message: string, kind: 'INVALID' | 'NOT_FOUND' | 'CONFLICT') =>
  new ExpenseRuleError(message, kind);

/**
 * `ExpenseRepository` en memoria para los casos de uso. Aplica las MISMAS
 * reglas del dominio que el repositorio de Prisma (tope, edición, estado
 * derivado, anulación única, idempotencia) para que un test de caso de uso
 * afirme sobre filas como lo haría un e2e sobre la tabla.
 */
export class InMemoryExpenseRepository implements ExpenseRepository {
  readonly expenses = new Map<string, StoredExpense>();
  readonly payments: StoredPayment[] = [];
  readonly users = new Map<string, string>();
  readonly locations = new Map<string, string>();
  /** Día civil que devuelve el «hoy» de cualquier sede. */
  today = '2026-10-23';
  defaultLocationId = LOCATION_ID;
  /** Sedes que `resolveLocation` rechaza (400). */
  invalidLocations = new Set<string>();
  /** El efectivo exige caja abierta en esta clínica. */
  cashRequireOpenSession = false;
  /** Hace fallar el próximo `create` con este error. */
  failNextCreate: Error | null = null;
  /** Lo que recibió el último `suppliers`. */
  lastSupplierQuery: string | null = null;
  private tick = 0;

  private nextDate(): Date {
    this.tick += 1;
    return new Date(Date.UTC(2026, 9, 23, 12, 0, this.tick));
  }

  // --- Ayudas de los tests ---------------------------------------------------
  seed(partial: Partial<StoredExpense> = {}): StoredExpense {
    const row: StoredExpense = {
      id: randomUUID(),
      locationId: LOCATION_ID,
      category: 'Papelería',
      supplier: null,
      description: null,
      amount: 100,
      currency: 'COP',
      invoiceDate: '2026-10-20',
      dueDate: null,
      attachment: null,
      createdById: USER_ID,
      createdAt: this.nextDate(),
      updatedAt: this.nextDate(),
      voidedAt: null,
      voidedById: null,
      voidReason: null,
      idempotencyKey: null,
      idempotencyFingerprint: null,
      ...partial,
    };
    this.expenses.set(row.id, row);
    return row;
  }

  seedPayment(
    expenseId: string,
    partial: Partial<StoredPayment> = {},
  ): StoredPayment {
    const expense = this.expenses.get(expenseId)!;
    const payment: StoredPayment = {
      id: randomUUID(),
      expenseId,
      locationId: expense.locationId,
      amount: 10,
      currency: expense.currency,
      method: 'TRANSFER',
      paidOn: this.today,
      cashSessionId: null,
      createdById: USER_ID,
      createdAt: this.nextDate(),
      voidedAt: null,
      voidedById: null,
      voidReason: null,
      idempotencyKey: null,
      idempotencyFingerprint: null,
      ...partial,
    };
    this.payments.push(payment);
    return payment;
  }

  paymentsOf(expenseId: string): StoredPayment[] {
    return this.payments.filter((p) => p.expenseId === expenseId);
  }

  // --- Puerto ------------------------------------------------------------------
  resolveLocation(
    requested: string | undefined,
  ): Promise<{ locationId: string; today: string }> {
    if (requested && this.invalidLocations.has(requested)) {
      return Promise.reject(rule(LOCATION_INVALID_MESSAGE, 'INVALID'));
    }
    return Promise.resolve({
      locationId: requested ?? this.defaultLocationId,
      today: this.today,
    });
  }

  locationToday(): Promise<string> {
    return Promise.resolve(this.today);
  }

  cashRequiresOpenSession(): Promise<boolean> {
    return Promise.resolve(this.cashRequireOpenSession);
  }

  locationNames(): Promise<Map<string, string>> {
    return Promise.resolve(new Map(this.locations));
  }

  userNames(ids: string[]): Promise<Map<string, string>> {
    return Promise.resolve(
      new Map(
        ids
          .filter((id) => this.users.has(id))
          .map((id) => [id, this.users.get(id)!]),
      ),
    );
  }

  private liveCents(expenseId: string): number {
    return this.paymentsOf(expenseId)
      .filter((p) => !p.voidedAt)
      .reduce((sum, p) => sum + toCents(p.amount), 0);
  }

  private entity(row: StoredExpense): Expense {
    const paidCents = this.liveCents(row.id);
    const derived = expenseStatus(
      {
        amountCents: toCents(row.amount),
        paidCents,
        voided: row.voidedAt !== null,
        dueDate: row.dueDate,
      },
      this.today,
    );
    return {
      id: row.id,
      locationId: row.locationId,
      category: row.category,
      supplier: row.supplier,
      description: row.description,
      amount: row.amount,
      currency: row.currency,
      invoiceDate: row.invoiceDate,
      dueDate: row.dueDate,
      attachment: row.attachment,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      voidedAt: row.voidedAt,
      voidedById: row.voidedById,
      voidReason: row.voidReason,
      paidAmount: fromCents(paidCents),
      status: derived.status,
      overdue: derived.overdue,
    };
  }

  private detail(row: StoredExpense): ExpenseDetail {
    return {
      ...this.entity(row),
      payments: this.paymentsOf(row.id).map((p) => ({
        id: p.id,
        expenseId: p.expenseId,
        locationId: p.locationId,
        amount: p.amount,
        currency: p.currency,
        method: p.method,
        paidOn: p.paidOn,
        cashSessionId: p.cashSessionId,
        createdById: p.createdById,
        createdAt: p.createdAt,
        voidedAt: p.voidedAt,
        voidedById: p.voidedById,
        voidReason: p.voidReason,
      })),
    };
  }

  private require(id: string): StoredExpense {
    const row = this.expenses.get(id);
    if (!row) throw rule(EXPENSE_NOT_FOUND_MESSAGE, 'NOT_FOUND');
    return row;
  }

  list(filters: ExpenseListFilters): Promise<ExpenseList> {
    const key = filters.query ? categoryKey(filters.query) : null;
    const rows = [...this.expenses.values()]
      .map((row) => this.entity(row))
      .filter((e) => !filters.from || e.invoiceDate >= filters.from)
      .filter((e) => !filters.to || e.invoiceDate <= filters.to)
      .filter((e) => !filters.locationId || e.locationId === filters.locationId)
      .filter(
        (e) =>
          !filters.category ||
          categoryKey(e.category) === categoryKey(filters.category),
      )
      .filter((e) =>
        filters.status === 'OPEN'
          ? e.status === 'PENDING' || e.status === 'PARTIAL'
          : !filters.status || e.status === filters.status,
      )
      .filter(
        (e) => filters.overdue === undefined || e.overdue === filters.overdue,
      )
      .filter(
        (e) =>
          key === null ||
          categoryKey(`${e.supplier ?? ''} ${e.description ?? ''}`).includes(
            key,
          ),
      )
      .sort(
        (a, b) =>
          b.invoiceDate.localeCompare(a.invoiceDate) ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      );
    const start = (filters.page - 1) * filters.pageSize;
    return Promise.resolve({
      items: rows.slice(start, start + filters.pageSize),
      total: rows.length,
      page: filters.page,
      pageSize: filters.pageSize,
    });
  }

  findById(id: string): Promise<ExpenseDetail | null> {
    const row = this.expenses.get(id);
    return Promise.resolve(row ? this.detail(row) : null);
  }

  findByIdempotencyKey(
    key: string,
  ): Promise<{ detail: ExpenseDetail; fingerprint: string | null } | null> {
    const row = [...this.expenses.values()].find(
      (e) => e.idempotencyKey === key,
    );
    return Promise.resolve(
      row
        ? { detail: this.detail(row), fingerprint: row.idempotencyFingerprint }
        : null,
    );
  }

  findPaymentByIdempotencyKey(
    key: string,
  ): Promise<{ expenseId: string; fingerprint: string | null } | null> {
    const payment = this.payments.find((p) => p.idempotencyKey === key);
    return Promise.resolve(
      payment
        ? {
            expenseId: payment.expenseId,
            fingerprint: payment.idempotencyFingerprint,
          }
        : null,
    );
  }

  /**
   * La caja de un pago desde el cajón, ANTES de escribir nada (como la
   * transacción real: si el enlace lanza 409, no queda ni gasto ni pago).
   * Solo se llama con enlace: sin él, comprobar e insertar no ceden el turno.
   */
  private cashSessionFor(
    expense: { locationId: string },
    input: CreateExpensePaymentRepoInput & { cashLink: ExpenseCashLink },
  ): Promise<string> {
    return input.cashLink.attachToOpenSession({} as never, {
      tenantId: TENANT_ID,
      locationId: expense.locationId,
      userId: input.createdById,
    });
  }

  private insertPayment(
    expense: StoredExpense,
    input: CreateExpensePaymentRepoInput,
    cashSessionId: string | null = null,
  ): StoredPayment {
    return this.seedPayment(expense.id, {
      amount: input.amount,
      method: input.method,
      paidOn: input.paidOn,
      cashSessionId,
      createdById: input.createdById,
      idempotencyKey: input.idempotencyKey ?? null,
      idempotencyFingerprint: input.idempotencyFingerprint ?? null,
    });
  }

  async create(
    input: CreateExpenseRepoInput,
    payment: CreateExpensePaymentRepoInput | undefined,
  ): Promise<IdempotentWrite> {
    if (this.failNextCreate) {
      const error = this.failNextCreate;
      this.failNextCreate = null;
      return Promise.reject(error);
    }
    // La caja solo necesita la sede (el gasto aún no existe).
    const cashSessionId = payment?.cashLink
      ? await this.cashSessionFor(
          { locationId: input.locationId },
          { ...payment, cashLink: payment.cashLink },
        )
      : null;
    // Comprobar e insertar sin ceder el turno: es el único de la BD.
    const original = input.idempotencyKey
      ? [...this.expenses.values()].find(
          (e) => e.idempotencyKey === input.idempotencyKey,
        )
      : undefined;
    if (original) {
      return Promise.resolve({
        detail: this.detail(original),
        created: false,
        fingerprint: original.idempotencyFingerprint,
      });
    }
    const row = this.seed({
      locationId: input.locationId,
      category: input.category,
      supplier: input.supplier,
      description: input.description,
      amount: input.amount,
      currency: input.currency,
      invoiceDate: input.invoiceDate,
      dueDate: input.dueDate,
      attachment: input.attachment,
      createdById: input.createdById,
      idempotencyKey: input.idempotencyKey ?? null,
      idempotencyFingerprint: input.idempotencyFingerprint ?? null,
    });
    if (payment) this.insertPayment(row, payment, cashSessionId);
    return Promise.resolve({
      detail: this.detail(row),
      created: true,
      fingerprint: input.idempotencyFingerprint ?? null,
    });
  }

  update(id: string, patch: UpdateExpenseRepoInput): Promise<ExpenseDetail> {
    const row = this.require(id);
    const denial = expenseEditDenial({
      current: {
        amountCents: toCents(row.amount),
        locationId: row.locationId,
        currency: row.currency,
        voided: row.voidedAt !== null,
      },
      patch: {
        amountCents:
          patch.amount !== undefined ? toCents(patch.amount) : undefined,
        locationId: patch.locationId,
        currency: patch.currency,
      },
      liveCents: this.liveCents(id),
      paymentCount: this.paymentsOf(id).length,
      currency: row.currency,
    });
    if (denial) return Promise.reject(denial);
    validateDueDate(
      patch.dueDate !== undefined ? patch.dueDate : row.dueDate,
      patch.invoiceDate ?? row.invoiceDate,
    );
    for (const field of [
      'category',
      'supplier',
      'description',
      'invoiceDate',
      'dueDate',
      'amount',
      'currency',
      'locationId',
    ] as const) {
      if (patch[field] !== undefined) {
        (row as unknown as Record<string, unknown>)[field] = patch[field];
      }
    }
    row.updatedAt = this.nextDate();
    return Promise.resolve(this.detail(row));
  }

  private voidPaymentRow(
    payment: StoredPayment,
    reason: string,
    by: string,
    cashLink: ExpenseCashLink | undefined,
  ): Promise<void> {
    if (payment.cashSessionId && !cashLink) {
      throw new Error('Un pago con caja se anula con su CashLink (R5)');
    }
    payment.voidedAt = this.nextDate();
    payment.voidedById = by;
    payment.voidReason = reason;
    return payment.cashSessionId && cashLink
      ? cashLink.onPaymentVoided({} as never, payment, reason, by)
      : Promise.resolve();
  }

  async void(
    id: string,
    reason: string,
    by: string,
    _now: Date,
    cashLink?: ExpenseCashLink,
  ): Promise<ExpenseDetail> {
    const row = this.require(id);
    if (row.voidedAt) {
      throw rule(EXPENSE_ALREADY_VOIDED_MESSAGE, 'CONFLICT');
    }
    const live = this.paymentsOf(id).filter((p) => !p.voidedAt);
    // Como la transacción real: si algo falla, no se anula nada.
    if (!cashLink && live.some((p) => p.cashSessionId)) {
      throw new Error('Un pago con caja se anula con su CashLink (R5)');
    }
    for (const payment of live) {
      await this.voidPaymentRow(payment, reason, by, cashLink);
    }
    row.voidedAt = this.nextDate();
    row.voidedById = by;
    row.voidReason = reason;
    return this.detail(row);
  }

  async addPayment(
    expenseId: string,
    input: CreateExpensePaymentRepoInput,
  ): Promise<IdempotentWrite> {
    const row = this.require(expenseId);
    if (row.voidedAt) throw rule(EXPENSE_VOIDED_MESSAGE, 'CONFLICT');
    const denial = paymentCapDenial({
      amountCents: toCents(row.amount),
      liveCents: this.liveCents(expenseId),
      paymentCents: toCents(input.amount),
      currency: row.currency,
    });
    if (denial) throw denial;
    const cashSessionId = input.cashLink
      ? await this.cashSessionFor(row, { ...input, cashLink: input.cashLink })
      : null;
    if (input.idempotencyKey) {
      const dup = this.payments.find(
        (p) => p.idempotencyKey === input.idempotencyKey,
      );
      if (dup) {
        return Promise.resolve({
          detail: this.detail(this.require(dup.expenseId)),
          created: false,
          fingerprint: dup.idempotencyFingerprint,
        });
      }
    }
    this.insertPayment(row, input, cashSessionId);
    return Promise.resolve({
      detail: this.detail(row),
      created: true,
      fingerprint: input.idempotencyFingerprint ?? null,
    });
  }

  async voidPayment(
    expenseId: string,
    paymentId: string,
    reason: string,
    by: string,
    _now: Date,
    cashLink?: ExpenseCashLink,
  ): Promise<ExpenseDetail> {
    const row = this.require(expenseId);
    const payment = this.paymentsOf(expenseId).find((p) => p.id === paymentId);
    if (!payment) throw rule(PAYMENT_NOT_FOUND_MESSAGE, 'NOT_FOUND');
    if (payment.voidedAt) {
      throw rule(PAYMENT_ALREADY_VOIDED_MESSAGE, 'CONFLICT');
    }
    await this.voidPaymentRow(payment, reason, by, cashLink);
    return this.detail(row);
  }

  suppliers(query: string, limit: number): Promise<SupplierSuggestion[]> {
    this.lastSupplierQuery = query;
    const key = categoryKey(query);
    const latest = new Map<string, { name: string; at: number }>();
    for (const e of this.expenses.values()) {
      if (!e.supplier || !categoryKey(e.supplier).includes(key)) continue;
      const k = categoryKey(e.supplier);
      const at = e.createdAt.getTime();
      if (!latest.has(k) || latest.get(k)!.at < at) {
        latest.set(k, { name: e.supplier, at });
      }
    }
    return Promise.resolve(
      [...latest.values()]
        .sort((a, b) => b.at - a.at || a.name.localeCompare(b.name))
        .slice(0, limit)
        .map((s) => ({ name: s.name })),
    );
  }

  attach(id: string, attachment: ExpenseAttachment): Promise<ExpenseDetail> {
    const row = this.require(id);
    if (row.voidedAt) throw rule(EXPENSE_VOIDED_MESSAGE, 'CONFLICT');
    if (row.attachment) throw rule(ATTACHMENT_ALREADY_MESSAGE, 'CONFLICT');
    row.attachment = attachment;
    return Promise.resolve(this.detail(row));
  }

  attachmentKeyInUse(key: string): Promise<boolean> {
    return Promise.resolve(
      [...this.expenses.values()].some((e) => e.attachment?.key === key),
    );
  }
}

/** `ExpenseCategoryRepository` en memoria (único entre vivas, retiro lógico). */
export class InMemoryExpenseCategoryRepository implements ExpenseCategoryRepository {
  readonly rows: (ExpenseCategory & { deleted: boolean })[] = [];
  /** Hace que `create` pierda una carrera (el único de la BD). */
  loseNextCreate = false;

  seed(name: string, partial: Partial<ExpenseCategory> = {}): ExpenseCategory {
    const row = {
      id: randomUUID(),
      name,
      active: true,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      deleted: false,
      ...partial,
    };
    this.rows.push(row);
    return row;
  }

  listActive(): Promise<ExpenseCategory[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => !r.deleted && r.active)
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
    );
  }

  findActiveByKey(key: string): Promise<ExpenseCategory | null> {
    return Promise.resolve(
      this.rows.find(
        (r) => !r.deleted && r.active && categoryKey(r.name) === key,
      ) ?? null,
    );
  }

  findLiveByKey(key: string): Promise<ExpenseCategory | null> {
    return Promise.resolve(
      this.rows.find((r) => !r.deleted && categoryKey(r.name) === key) ?? null,
    );
  }

  create(name: string): Promise<ExpenseCategory | null> {
    if (this.loseNextCreate) {
      this.loseNextCreate = false;
      return Promise.resolve(null);
    }
    return Promise.resolve(this.seed(name));
  }

  retire(id: string): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id && !r.deleted);
    if (!row) return Promise.resolve(false);
    row.deleted = true;
    row.active = false;
    return Promise.resolve(true);
  }
}

/** Moneda conocida para los tests: COP y USD. */
export const KNOWN_CURRENCIES = {
  has: (code: string): Promise<boolean> =>
    Promise.resolve(['COP', 'USD'].includes(code)),
};
