import type { Prisma } from '@prisma/client';
import type {
  Expense,
  ExpenseAttachment,
  ExpenseDetail,
  ExpensePayment,
  ReceiptMimeType,
} from '../../domain/entities/expense.entity';
import { expenseStatus, fromCents, toCents } from '../../domain/expense-rules';

/** Lo que el mapper necesita de un gasto, venga de Prisma o de SQL crudo. */
export interface ExpenseCore {
  id: string;
  locationId: string;
  category: string;
  supplier: string | null;
  description: string | null;
  amountCents: number;
  currency: string;
  invoiceDate: Date;
  dueDate: Date | null;
  attachmentKey: string | null;
  attachmentMime: string | null;
  attachmentSize: number | null;
  attachmentSha256: string | null;
  attachmentName: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  voidedAt: Date | null;
  voidedById: string | null;
  voidReason: string | null;
}

type PrismaExpense = Prisma.ExpenseGetPayload<Record<string, never>>;
type PrismaExpensePayment = Prisma.ExpensePaymentGetPayload<
  Record<string, never>
>;

/** `@db.Date` llega como medianoche UTC: el día civil es su fecha ISO. */
export function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** El día civil `YYYY-MM-DD` como columna `@db.Date`. */
export function dateOfDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export function coreOfRow(row: PrismaExpense): ExpenseCore {
  return {
    id: row.id,
    locationId: row.locationId,
    category: row.category,
    supplier: row.supplier,
    description: row.description,
    amountCents: toCents(Number(row.amount)),
    currency: row.currency,
    invoiceDate: row.invoiceDate,
    dueDate: row.dueDate,
    attachmentKey: row.attachmentKey,
    attachmentMime: row.attachmentMime,
    attachmentSize: row.attachmentSize,
    attachmentSha256: row.attachmentSha256,
    attachmentName: row.attachmentName,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    voidedAt: row.voidedAt,
    voidedById: row.voidedById,
    voidReason: row.voidReason,
  };
}

function attachmentOf(core: ExpenseCore): ExpenseAttachment | null {
  if (
    core.attachmentKey === null ||
    core.attachmentMime === null ||
    core.attachmentSize === null ||
    core.attachmentSha256 === null ||
    core.attachmentName === null
  ) {
    return null;
  }
  return {
    key: core.attachmentKey,
    mime: core.attachmentMime as ReceiptMimeType,
    size: core.attachmentSize,
    sha256: core.attachmentSha256,
    name: core.attachmentName,
  };
}

/** `today` es el día civil de la sede del gasto. */
export function mapExpense(
  core: ExpenseCore,
  paidCents: number,
  today: string,
): Expense {
  const dueDate = core.dueDate ? dayOf(core.dueDate) : null;
  const derived = expenseStatus(
    {
      amountCents: core.amountCents,
      paidCents,
      voided: core.voidedAt !== null,
      dueDate,
    },
    today,
  );
  return {
    id: core.id,
    locationId: core.locationId,
    category: core.category,
    supplier: core.supplier,
    description: core.description,
    amount: fromCents(core.amountCents),
    currency: core.currency,
    invoiceDate: dayOf(core.invoiceDate),
    dueDate,
    attachment: attachmentOf(core),
    createdById: core.createdById,
    createdAt: core.createdAt,
    updatedAt: core.updatedAt,
    voidedAt: core.voidedAt,
    voidedById: core.voidedById,
    voidReason: core.voidReason,
    paidAmount: fromCents(paidCents),
    status: derived.status,
    overdue: derived.overdue,
  };
}

export function mapPayment(row: PrismaExpensePayment): ExpensePayment {
  return {
    id: row.id,
    expenseId: row.expenseId,
    locationId: row.locationId,
    amount: Number(row.amount),
    currency: row.currency,
    method: row.method,
    paidOn: dayOf(row.paidOn),
    cashSessionId: row.cashSessionId,
    createdById: row.createdById,
    createdAt: row.createdAt,
    voidedAt: row.voidedAt,
    voidedById: row.voidedById,
    voidReason: row.voidReason,
  };
}

/** Σ de los pagos vivos en céntimos. */
export function liveCentsOf(payments: PrismaExpensePayment[]): number {
  return payments
    .filter((p) => p.voidedAt === null)
    .reduce((sum, p) => sum + toCents(Number(p.amount)), 0);
}

export function mapDetail(
  row: PrismaExpense & { payments: PrismaExpensePayment[] },
  today: string,
): ExpenseDetail {
  return {
    ...mapExpense(coreOfRow(row), liveCentsOf(row.payments), today),
    payments: row.payments.map(mapPayment),
  };
}
