import type { PaymentMethod } from '@prisma/client';
import type {
  Expense,
  ExpenseAttachment,
  ExpenseDetail,
  ExpensePayment,
  ExpenseStatus,
} from '../domain/entities/expense.entity';
import { fromCents, toCents } from '../domain/expense-rules';
import type { ExpenseRepository } from '../domain/ports/expense-repository.port';

/** El soporte tal como lo ve la API: sin la clave del almacén. */
export interface ExpenseAttachmentView {
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export interface ExpensePaymentView {
  id: string;
  amount: number;
  currency: string;
  method: PaymentMethod;
  paidOn: string;
  /** Con caja es una salida de caja. */
  cashSessionId: string | null;
  createdById: string;
  createdByName: string | null;
  createdAt: Date;
  voidedAt: Date | null;
  voidedById: string | null;
  voidedByName: string | null;
  voidReason: string | null;
}

export interface ExpenseView {
  id: string;
  locationId: string;
  category: string;
  supplier: string | null;
  description: string | null;
  amount: number;
  currency: string;
  invoiceDate: string;
  dueDate: string | null;
  paidAmount: number;
  pendingAmount: number;
  status: ExpenseStatus;
  overdue: boolean;
  attachment: ExpenseAttachmentView | null;
  createdById: string;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  voidedAt: Date | null;
  voidedById: string | null;
  voidedByName: string | null;
  voidReason: string | null;
}

export interface ExpenseDetailView extends ExpenseView {
  payments: ExpensePaymentView[];
}

function attachmentView(
  a: ExpenseAttachment | null,
): ExpenseAttachmentView | null {
  return a
    ? { name: a.name, mimeType: a.mime, sizeBytes: a.size, sha256: a.sha256 }
    : null;
}

function toView(e: Expense, names: Map<string, string>): ExpenseView {
  return {
    id: e.id,
    locationId: e.locationId,
    category: e.category,
    supplier: e.supplier,
    description: e.description,
    amount: e.amount,
    currency: e.currency,
    invoiceDate: e.invoiceDate,
    dueDate: e.dueDate,
    paidAmount: e.paidAmount,
    // Un gasto anulado no debe nada.
    pendingAmount:
      e.status === 'VOIDED'
        ? 0
        : fromCents(Math.max(toCents(e.amount) - toCents(e.paidAmount), 0)),
    status: e.status,
    overdue: e.overdue,
    attachment: attachmentView(e.attachment),
    createdById: e.createdById,
    createdByName: names.get(e.createdById) ?? null,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    voidedAt: e.voidedAt,
    voidedById: e.voidedById,
    voidedByName: e.voidedById ? (names.get(e.voidedById) ?? null) : null,
    voidReason: e.voidReason,
  };
}

function paymentView(
  p: ExpensePayment,
  names: Map<string, string>,
): ExpensePaymentView {
  return {
    id: p.id,
    amount: p.amount,
    currency: p.currency,
    method: p.method,
    paidOn: p.paidOn,
    cashSessionId: p.cashSessionId,
    createdById: p.createdById,
    createdByName: names.get(p.createdById) ?? null,
    createdAt: p.createdAt,
    voidedAt: p.voidedAt,
    voidedById: p.voidedById,
    voidedByName: p.voidedById ? (names.get(p.voidedById) ?? null) : null,
    voidReason: p.voidReason,
  };
}

function collectIds(expenses: Expense[], payments: ExpensePayment[]): string[] {
  const ids = new Set<string>();
  for (const e of expenses) {
    ids.add(e.createdById);
    if (e.voidedById) ids.add(e.voidedById);
  }
  for (const p of payments) {
    ids.add(p.createdById);
    if (p.voidedById) ids.add(p.voidedById);
  }
  return [...ids];
}

/** Vistas de una página de gastos con UNA consulta de nombres. */
export async function viewsOf(
  repo: ExpenseRepository,
  expenses: Expense[],
): Promise<ExpenseView[]> {
  const names = await repo.userNames(collectIds(expenses, []));
  return expenses.map((e) => toView(e, names));
}

export async function detailViewOf(
  repo: ExpenseRepository,
  detail: ExpenseDetail,
): Promise<ExpenseDetailView> {
  const names = await repo.userNames(collectIds([detail], detail.payments));
  return {
    ...toView(detail, names),
    payments: detail.payments.map((p) => paymentView(p, names)),
  };
}
