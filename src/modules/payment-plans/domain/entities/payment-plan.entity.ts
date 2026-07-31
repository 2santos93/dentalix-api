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
