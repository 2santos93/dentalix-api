import type { DocumentType, PaymentMethod } from '@prisma/client';
import { maskDocument } from '../../../shared/privacy/mask-document';
import { splitTotal } from './split-payment';
import {
  documentTypeName,
  type ClinicDocumentTypeNames,
} from '../../patients/domain/document-type';
import { docTypeFromStored } from '../../patients/domain/legacy-document-codes';
import type { ReceiptTexts } from './receipt-settings';
import type { CurrencyTexts } from '../../../shared/format/currency-text';

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

/** Saldo migrado del recibo (DX-262): concepto y fecha de corte (AAAA-MM-DD). */
export interface ReceiptOpeningBalance {
  id: string;
  concept: string;
  asOfDate: string;
}

/**
 * DX-390: una forma de pago de un cobro dividido, tal como sale en su recibo
 * único. `equivalentAmount`: la línea en la moneda del plan con su tasa
 * congelada al emitir; `null` si quedó «sin tasa».
 */
export interface ReceiptSplitLine {
  paymentId: string;
  line: number;
  amount: number;
  currency: string;
  method: PaymentMethod | null;
  paymentMethodName: string | null;
  reference: string | null;
  equivalentAmount: number | null;
}

/**
 * DX-390: las formas de pago del cobro y su total en la moneda del plan
 * (`amount` `null` si alguna línea quedó «sin tasa» al emitir).
 */
export interface ReceiptSplit {
  lines: ReceiptSplitLine[];
  total: { currency: string; amount: number | null };
}

/** Lo que se lee, en la transacción del abono, para congelar el recibo. */
export interface ReceiptSnapshotInput {
  clinic: ReceiptClinicData;
  location: ReceiptLocationData;
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    docType: DocumentType;
    /** DX-327: nombre libre del documento (R7); null = sin etiqueta. */
    docTypeLabel: string | null;
    docNumber: string | null;
  };
  payment: {
    id: string;
    amount: number;
    currency: string;
    method: PaymentMethod | null;
    /** DX-377: nombre del medio de pago y referencia (null = sin ellos). */
    paymentMethodName?: string | null;
    reference?: string | null;
    paidAt: Date;
    paidOn: string;
  };
  /** Plan del abono; `null` si es contra un saldo migrado (DX-262). */
  plan: { id: string; optionLabel: string | null; createdAt: Date } | null;
  /** Saldo migrado del abono (DX-262); `null`/ausente si es a un plan. */
  openingBalance?: ReceiptOpeningBalance | null;
  /**
   * Saldo del destino tras el abono, en su moneda (el plan; o el saldo
   * migrado, con `billable` = su importe); null si no se pudo calcular.
   */
  planBalance: ReceiptPlanBalance | null;
  cashier: { id: string; fullName: string } | null;
  /** DX-390: las líneas de un cobro dividido (ausente en un abono suelto). */
  split?: { lines: ReceiptSplitLine[]; planCurrency: string } | null;
  /**
   * DX-515: título y leyenda configurados al emitir (la leyenda, ya resuelta
   * entre la de la clínica y la de la sede). Ausente o `null` = sin ellos.
   */
  texts?: ReceiptTexts | null;
  /** DX-517: texto propio de cada moneda de la clínica al emitir. Vacío o ausente = ninguno. */
  currencyTexts?: CurrencyTexts | null;
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
  /** Falta la razón social o el identificador fiscal: el recibo dice «Datos fiscales pendientes». */
  fiscalDataPending: boolean;
  /**
   * DX-327 (R6 y R18): las fotos llevan el tipo genérico, la etiqueta y el
   * nombre visible congelado. Las emitidas antes de la migración
   * 20261110130000 llevan además (o solo, las anteriores a DX-327) el código
   * anterior en `docType`; la foto es inmutable y no se reescribe. Se lee
   * SIEMPRE con `receiptPatientView`.
   */
  patient: {
    id: string;
    fullName: string;
    docType?: string;
    documentType?: DocumentType;
    docTypeLabel?: string | null;
    docTypeName?: string;
    docNumberMasked: string | null;
  };
  payment: {
    id: string;
    amount: number;
    currency: string;
    method: PaymentMethod | null;
    /** DX-377: ausentes en los recibos anteriores. */
    paymentMethodName?: string | null;
    reference?: string | null;
    paidAt: string;
    paidOn: string;
  };
  /** `null` en un abono contra un saldo migrado (DX-262). */
  plan: { id: string; optionLabel: string | null; createdAt: string } | null;
  /** Saldo migrado (DX-262); ausente en los recibos anteriores. */
  openingBalance?: ReceiptOpeningBalance | null;
  planBalance: ReceiptPlanBalance | null;
  cashier: { id: string; fullName: string } | null;
  /**
   * DX-390: el cobro dividido del recibo, con todas sus formas de pago y el
   * total en la moneda del plan. Ausente o `null` en un abono suelto y en los
   * recibos anteriores; `payment` es entonces su línea 1.
   */
  split?: ReceiptSplit | null;
  legalNotice: string;
  /**
   * DX-515: el título del recibo que configuró la clínica, congelado al
   * emitir. AUSENTE si no tenía (la web pone «Recibo de caja»): la foto de
   * una clínica sin título es la misma de antes de DX-515.
   */
  title?: string;
  /**
   * DX-515: la leyenda de la clínica o de la sede, congelada al emitir.
   * AUSENTE si no había: el recibo no imprime nada y reimprimir un recibo
   * anterior no la añade aunque la clínica la configure después.
   */
  legend?: string;
  /**
   * DX-517: el texto propio de cada moneda que tenía la clínica al emitir
   * ({«VES»: «Bs.»}), con el que se pintan los importes del recibo y de su
   * email. AUSENTE si no tenía ninguno: la foto es la de antes y reimprimir
   * un recibo anterior no cambia sus importes aunque la clínica lo configure
   * después.
   */
  currencyTexts?: CurrencyTexts;
}

const blankToNull = (value: string | null): string | null =>
  value?.trim() ? value.trim() : null;

/**
 * `clinicNames`: los nombres locales de la clínica al emitir (R16); el
 * nombre visible queda congelado en la foto (R18).
 */
export function buildReceiptSnapshot(
  input: ReceiptSnapshotInput,
  clinicNames: ClinicDocumentTypeNames,
): ReceiptSnapshot {
  const { docType, docTypeLabel } = input.patient;
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
      documentType: docType,
      docTypeLabel,
      docTypeName: documentTypeName(docType, docTypeLabel, clinicNames),
      docNumberMasked: maskDocument(input.patient.docNumber),
    },
    payment: {
      id: input.payment.id,
      amount: input.payment.amount,
      currency: input.payment.currency,
      method: input.payment.method,
      paymentMethodName: input.payment.paymentMethodName ?? null,
      reference: input.payment.reference ?? null,
      paidAt: input.payment.paidAt.toISOString(),
      paidOn: input.payment.paidOn,
    },
    plan: input.plan
      ? {
          id: input.plan.id,
          optionLabel: input.plan.optionLabel,
          createdAt: input.plan.createdAt.toISOString(),
        }
      : null,
    openingBalance: input.openingBalance ?? null,
    planBalance: input.planBalance,
    cashier: input.cashier,
    ...(input.split ? { split: receiptSplit(input.split) } : {}),
    legalNotice: RECEIPT_LEGAL_NOTICE,
    // DX-515: solo si están configurados, para no cambiar la foto de antes.
    ...(input.texts?.title ? { title: input.texts.title } : {}),
    ...(input.texts?.legend ? { legend: input.texts.legend } : {}),
    // DX-517: igual, solo si la clínica tiene alguno.
    ...(input.currencyTexts && Object.keys(input.currencyTexts).length > 0
      ? { currencyTexts: { ...input.currencyTexts } }
      : {}),
  };
}

/** DX-390: las líneas y su total al céntimo (`null` si alguna no tiene tasa). */
function receiptSplit(split: {
  lines: ReceiptSplitLine[];
  planCurrency: string;
}): ReceiptSplit {
  const equivalents = split.lines.map((line) => line.equivalentAmount);
  return {
    lines: split.lines,
    total: { currency: split.planCurrency, amount: splitTotal(equivalents) },
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

/** El paciente del recibo tal como se muestra, se imprime y se envía. */
export interface ReceiptPatientView {
  id: string;
  fullName: string;
  docType: DocumentType;
  docTypeLabel: string | null;
  /** «{docTypeName} {docNumberMasked}» es lo que pintan la web y el email. */
  docTypeName: string;
  docNumberMasked: string | null;
}

/** La foto del recibo con su paciente ya leído (`receiptPatientView`). */
export type ReceiptViewSnapshot = Omit<ReceiptSnapshot, 'patient'> & {
  patient: ReceiptPatientView;
};

/**
 * DX-327 (R6 y R18): una foto nueva da su nombre visible congelado; una
 * anterior solo guardó el código, que se traduce a su tipo genérico SIN
 * etiqueta y se pinta con el nombre local de hoy de la clínica, o el
 * genérico. Un código desconocido es un fallo de despliegue: lanza.
 */
export function receiptPatientView(
  snapshot: ReceiptSnapshot,
  clinicNames: ClinicDocumentTypeNames,
): ReceiptPatientView {
  const { patient } = snapshot;
  const docType = docTypeFromStored(
    String(patient.documentType ?? patient.docType),
  );
  const docTypeLabel = patient.docTypeLabel ?? null;
  return {
    id: patient.id,
    fullName: patient.fullName,
    docType,
    docTypeLabel,
    docTypeName:
      patient.docTypeName ??
      documentTypeName(docType, docTypeLabel, clinicNames),
    docNumberMasked: patient.docNumberMasked,
  };
}
