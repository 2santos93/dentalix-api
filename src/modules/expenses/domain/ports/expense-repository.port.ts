import type { PaymentMethod } from '@prisma/client';
import type {
  Expense,
  ExpenseAttachment,
  ExpenseDetail,
  ExpenseStatus,
} from '../entities/expense.entity';
import type { ExpenseCashLink } from './expense-cash-link.port';

export const EXPENSE_REPOSITORY = Symbol('EXPENSE_REPOSITORY');

/** `OPEN` = pendiente + parcial (lo que todavía se debe). */
export type ExpenseStatusFilter = ExpenseStatus | 'OPEN';

export interface ExpenseListFilters {
  /** Día de factura, desde (incluido). */
  from?: string;
  /** Día de factura, hasta (incluido). */
  to?: string;
  locationId?: string;
  category?: string;
  status?: ExpenseStatusFilter;
  overdue?: boolean;
  /** Proveedor o descripción, sin mayúsculas ni tildes. */
  query?: string;
  page: number;
  pageSize: number;
}

export interface ExpenseList {
  items: Expense[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateExpensePaymentRepoInput {
  amount: number;
  method: PaymentMethod;
  paidOn: string;
  createdById: string;
  /** Idempotency-Key (UUID) y huella de la petición, si vino. */
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
  /**
   * Solo para pagos desde el cajón (Task 3): toma la caja abierta del usuario.
   * Sin él, el pago no toca ninguna caja.
   */
  cashLink?: ExpenseCashLink;
}

export interface CreateExpenseRepoInput {
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
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
}

/**
 * Lo que `PATCH` cambia. Ausente = no se toca; `null` vacía supplier,
 * description y dueDate. Los valores ya vienen validados y normalizados.
 */
export interface UpdateExpenseRepoInput {
  category?: string;
  supplier?: string | null;
  description?: string | null;
  invoiceDate?: string;
  dueDate?: string | null;
  amount?: number;
  currency?: string;
  locationId?: string;
}

export interface SupplierSuggestion {
  name: string;
}

/** La respuesta de un alta o un pago con Idempotency-Key. */
export interface IdempotentWrite {
  detail: ExpenseDetail;
  /** false = otra petición con la misma clave ya la había creado. */
  created: boolean;
  /** Huella de la petición que la creó (para comparar con la de ahora). */
  fingerprint: string | null;
}

export interface ExpenseRepository {
  /**
   * Sede donde se escribe y su «hoy» civil. Con `requested`: debe estar entre
   * las sedes permitidas del usuario (403) y ser una sede activa de la
   * clínica (400); sin ella, la de la cabecera o la primera permitida.
   */
  resolveLocation(
    requested: string | undefined,
    now: Date,
  ): Promise<{ locationId: string; today: string }>;

  /** Día civil de hoy en la sede (aunque ya no esté activa). */
  locationToday(locationId: string, now: Date): Promise<string>;

  /** `Tenant.cashRequireOpenSession`: el efectivo exige una caja abierta. */
  cashRequiresOpenSession(): Promise<boolean>;

  /**
   * Página de gastos de las sedes visibles, con su estado y lo pagado. Con
   * `withTotal: false` se salta el conteo (la exportación no lo necesita) y
   * `total` es el nº de filas devueltas.
   */
  list(
    filters: ExpenseListFilters,
    now: Date,
    withTotal?: boolean,
  ): Promise<ExpenseList>;

  /**
   * Gasto con sus pagos si está en una sede visible para el usuario; si no
   * (inexistente, de otra clínica o de otra sede), `null`.
   */
  findById(id: string, now: Date): Promise<ExpenseDetail | null>;

  /** Gasto creado con esta Idempotency-Key, si existe. */
  findByIdempotencyKey(
    key: string,
    now: Date,
  ): Promise<{ detail: ExpenseDetail; fingerprint: string | null } | null>;

  /** Pago creado con esta Idempotency-Key, si existe. */
  findPaymentByIdempotencyKey(
    key: string,
  ): Promise<{ expenseId: string; fingerprint: string | null } | null>;

  /** Alta del gasto (y su primer pago, en la misma transacción). */
  create(
    input: CreateExpenseRepoInput,
    payment: CreateExpensePaymentRepoInput | undefined,
    now: Date,
  ): Promise<IdempotentWrite>;

  /**
   * Edita bajo el gasto bloqueado: aplica `expenseEditDenial` con lo pagado
   * en ese instante. Lanza `ExpenseRuleError`.
   */
  update(
    id: string,
    patch: UpdateExpenseRepoInput,
    now: Date,
  ): Promise<ExpenseDetail>;

  /**
   * Anula el gasto y todos sus pagos vivos en una transacción (los de caja
   * pasan por `cashLink.onPaymentVoided`). Lanza `ExpenseRuleError`.
   */
  void(
    id: string,
    reason: string,
    by: string,
    now: Date,
    cashLink?: ExpenseCashLink,
  ): Promise<ExpenseDetail>;

  /**
   * Registra un pago con el gasto `FOR UPDATE` y el tope R2 comprobado con lo
   * pagado en ese instante. Lanza `ExpenseRuleError`.
   */
  addPayment(
    expenseId: string,
    input: CreateExpensePaymentRepoInput,
    now: Date,
  ): Promise<IdempotentWrite>;

  /** Anula un pago (una vez). Lanza `ExpenseRuleError`. */
  voidPayment(
    expenseId: string,
    paymentId: string,
    reason: string,
    by: string,
    now: Date,
    cashLink?: ExpenseCashLink,
  ): Promise<ExpenseDetail>;

  /** Proveedores distintos usados, el más reciente primero (≤ `limit`). */
  suppliers(query: string, limit: number): Promise<SupplierSuggestion[]>;

  /**
   * Fija el soporte (una sola vez, en gastos no anulados). Lanza
   * `ExpenseRuleError`.
   */
  attach(
    id: string,
    attachment: ExpenseAttachment,
    now: Date,
  ): Promise<ExpenseDetail>;

  /** ¿Algún gasto de la clínica usa ya este objeto como soporte? */
  attachmentKeyInUse(key: string): Promise<boolean>;

  /** Nombre de cada sede de la clínica, incluidas las retiradas. */
  locationNames(): Promise<Map<string, string>>;

  /** Nombres de usuarios de la clínica por id. */
  userNames(ids: string[]): Promise<Map<string, string>>;
}
