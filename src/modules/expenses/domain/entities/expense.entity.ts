import type { PaymentMethod } from '@prisma/client';

/**
 * Estado DERIVADO de un gasto (R2): no se guarda; sale de la anulación y de
 * la suma de sus pagos vivos.
 */
export type ExpenseStatus = 'PENDING' | 'PARTIAL' | 'PAID' | 'VOIDED';

export const RECEIPT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const;
export type ReceiptMimeType = (typeof RECEIPT_MIME_TYPES)[number];

/** Soporte del gasto (PDF/JPG/PNG). Una vez fijado no cambia (trigger). */
export interface ExpenseAttachment {
  /** Clave en el almacén: no sale nunca por la API. */
  key: string;
  mime: ReceiptMimeType;
  size: number;
  sha256: string;
  /** Nombre original, solo para mostrar. */
  name: string;
}

/**
 * Gasto de una sede (DX-274). Las fechas son días civiles `YYYY-MM-DD`. Los
 * importes van en unidades de la moneda (2 decimales); las cuentas se hacen en
 * céntimos enteros.
 */
export interface Expense {
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
  /** Σ de los pagos vivos. */
  paidAmount: number;
  status: ExpenseStatus;
  /** No pagado del todo y con el vencimiento ya pasado (día civil de la sede). */
  overdue: boolean;
}

export interface ExpensePayment {
  id: string;
  expenseId: string;
  locationId: string;
  amount: number;
  currency: string;
  method: PaymentMethod;
  paidOn: string;
  /** Con caja es una salida de caja (solo efectivo). */
  cashSessionId: string | null;
  createdById: string;
  createdAt: Date;
  voidedAt: Date | null;
  voidedById: string | null;
  voidReason: string | null;
}

export interface ExpenseDetail extends Expense {
  payments: ExpensePayment[];
}
