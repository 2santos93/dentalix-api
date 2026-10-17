import { DocType, PaymentMethod } from '@prisma/client';
import { maskDocument } from '../../../shared/privacy/mask-document';

/** Pie legal por defecto del recibo de caja (DX-136). */
export const RECEIPT_LEGAL_NOTICE = 'Este documento no es factura';

/** Datos fiscales de la clínica. Hoy solo existe el nombre (DX-019 añadirá el resto). */
export interface ReceiptClinicData {
  name: string;
  legalName: string | null;
  taxId: string | null;
  address: string | null;
}

export interface ReceiptLocationData {
  id: string;
  name: string;
  address: string | null;
}

export interface ReceiptPlanBalance {
  currency: string;
  billable: number;
  paid: number;
  balance: number;
}

/** Lo que se lee, en la transacción del abono, para congelar el recibo. */
export interface ReceiptSnapshotInput {
  clinic: ReceiptClinicData;
  location: ReceiptLocationData;
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    docType: DocType;
    docNumber: string | null;
  };
  payment: {
    id: string;
    amount: number;
    currency: string;
    method: PaymentMethod | null;
    paidAt: Date;
    paidOn: string;
  };
  plan: { id: string; optionLabel: string | null; createdAt: Date };
  /** Saldo del plan tras el abono, en su moneda; null si no se pudo calcular. */
  planBalance: ReceiptPlanBalance | null;
  cashier: { id: string; fullName: string } | null;
}

/**
 * Foto inmutable del recibo (`payment_receipts.snapshot`, jsonb). Se guarda
 * al emitir y nunca cambia (trigger): reimprimir o reenviar muestra estos
 * datos aunque después cambien la clínica, la sede, el paciente o el saldo.
 * El documento del paciente va SIEMPRE enmascarado; las fechas, en ISO.
 */
export interface ReceiptSnapshot {
  version: 1;
  clinic: ReceiptClinicData;
  location: ReceiptLocationData;
  /** Falta la razón social o el NIT/NIF: el recibo dice «Datos fiscales pendientes». */
  fiscalDataPending: boolean;
  patient: {
    id: string;
    fullName: string;
    docType: DocType;
    docNumberMasked: string | null;
  };
  payment: {
    id: string;
    amount: number;
    currency: string;
    method: PaymentMethod | null;
    paidAt: string;
    paidOn: string;
  };
  plan: { id: string; optionLabel: string | null; createdAt: string };
  planBalance: ReceiptPlanBalance | null;
  cashier: { id: string; fullName: string } | null;
  legalNotice: string;
}

const blankToNull = (value: string | null): string | null =>
  value?.trim() ? value.trim() : null;

export function buildReceiptSnapshot(
  input: ReceiptSnapshotInput,
): ReceiptSnapshot {
  const clinic: ReceiptClinicData = {
    name: input.clinic.name,
    legalName: blankToNull(input.clinic.legalName),
    taxId: blankToNull(input.clinic.taxId),
    address: blankToNull(input.clinic.address),
  };
  return {
    version: 1,
    clinic,
    location: {
      id: input.location.id,
      name: input.location.name,
      address: blankToNull(input.location.address),
    },
    fiscalDataPending: clinic.legalName === null || clinic.taxId === null,
    patient: {
      id: input.patient.id,
      fullName: `${input.patient.firstName.trim()} ${input.patient.lastName.trim()}`,
      docType: input.patient.docType,
      docNumberMasked: maskDocument(input.patient.docNumber),
    },
    payment: {
      id: input.payment.id,
      amount: input.payment.amount,
      currency: input.payment.currency,
      method: input.payment.method,
      paidAt: input.payment.paidAt.toISOString(),
      paidOn: input.payment.paidOn,
    },
    plan: {
      id: input.plan.id,
      optionLabel: input.plan.optionLabel,
      createdAt: input.plan.createdAt.toISOString(),
    },
    planBalance: input.planBalance,
    cashier: input.cashier,
    legalNotice: RECEIPT_LEGAL_NOTICE,
  };
}

/**
 * La foto tal como sale de la BD (jsonb). Solo se escribe con
 * `buildReceiptSnapshot`; si la versión no es la conocida es un fallo de
 * despliegue y no se muestra un recibo a medias.
 */
export function parseReceiptSnapshot(value: unknown): ReceiptSnapshot {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { version?: unknown }).version !== 1
  ) {
    throw new Error('Foto de recibo con una versión desconocida');
  }
  return value as ReceiptSnapshot;
}
