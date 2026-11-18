import { Periodicity } from '../../application/schedule/generate-schedule';

export type PaymentPlanStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

export interface Installment {
  id: string;
  sequence: number;
  dueDate: Date;
  amount: number;
}

export interface PaymentPlan {
  id: string;
  tenantId: string;
  treatmentPlanId: string;
  patientId: string;
  currency: string;
  totalToFinance: number;
  downPayment: number;
  installmentsCount: number;
  periodicity: Periodicity;
  startDate: Date;
  status: PaymentPlanStatus;
  notes: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentPlanWithInstallments extends PaymentPlan {
  installments: Installment[];
}

/** DX-092 (SEC-029): quién cancela un plan de cuotas, cuándo y por qué. */
export interface PaymentPlanCancellation {
  byId: string;
  at: Date;
  reason: string;
}

/**
 * DX-123 (O-2): un plan de cuotas cancelado, para el historial de la ficha.
 * Los cancelados antes de DX-109 no guardaron autor ni motivo (`null`); su
 * fecha es la del borrado lógico.
 */
export interface CancelledPaymentPlan {
  id: string;
  currency: string;
  totalToFinance: number;
  downPayment: number;
  installmentsCount: number;
  periodicity: Periodicity;
  startDate: Date;
  createdAt: Date;
  cancelledAt: Date;
  cancelledBy: { id: string; fullName: string | null } | null;
  cancelReason: string | null;
}
