import type { PaymentMethod } from '@prisma/client';
import type { RegionalFormat } from '../../../shared/format/regional-format';
import { moneyWithCode } from '../../../shared/format/money-with-code';
import { requireLocationFormat } from '../../../shared/locations/location-regional';
import { fromCents, toCents } from '../../../shared/money/money';
import { toWinAnsi } from '../../../shared/pdf/win-ansi';
import type {
  DocumentFormat,
  DocumentLine,
  SettlementDocumentSource,
} from './ports/commission-payment-repository.port';
import {
  canonicalJson,
  settlementPaymentState,
  sha256Hex,
  type SettlementPaymentStatus,
} from './settlement-payments';
import type { CommissionPaymentView } from './views';

/**
 * DX-464: lo que sale de la clínica sobre una liquidación (el PDF y el enlace
 * de conformidad). Solo iniciales del paciente, nunca su nombre ni nada
 * clínico más allá del procedimiento liquidado.
 */

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Efectivo',
  CARD: 'Tarjeta',
  TRANSFER: 'Transferencia',
  OTHER: 'Otro',
};

export const PAYMENT_STATUS_LABELS: Record<SettlementPaymentStatus, string> = {
  UNPAID: 'Pendiente de pago',
  PARTIALLY_PAID: 'Pagada parcialmente',
  PAID: 'Pagada',
  NOTHING_TO_PAY: 'Sin importe a pagar',
};

/** DX-018-bis: el recibo no congela la regla; remite a la liquidación. */
export const RECEIPT_BASE_NOTE =
  'La base de cada prestación es la de la liquidación, con los descuentos de laboratorio y pasarela que aplicara su regla. Sin otras deducciones.';

/**
 * DX-018-bis: qué descontó la base al cerrar (la regla congelada). Los
 * honorarios no llevan otras deducciones (fila «Deducciones» en 0).
 */
export function deductionsNote(source: {
  deductLabCost: boolean;
  deductCardFee: boolean;
}): string {
  if (source.deductLabCost && source.deductCardFee) {
    return 'La base descuenta el costo de laboratorio de cada prestación (en la moneda del plan) y la comisión de la pasarela del medio de pago de cada abono, antes del porcentaje.';
  }
  if (source.deductLabCost) {
    return 'La base descuenta el costo de laboratorio de cada prestación (en la moneda del plan), antes del porcentaje. No descuenta la comisión de la pasarela.';
  }
  if (source.deductCardFee) {
    return 'La base descuenta la comisión de la pasarela del medio de pago de cada abono, antes del porcentaje. No descuenta el costo de laboratorio.';
  }
  return 'La base no descuenta el costo de laboratorio ni la comisión de la pasarela.';
}

export interface ReceiptLine {
  kind: 'ACCRUAL' | 'ADJUSTMENT';
  patientInitials: string;
  catalogCode: string;
  catalogLabel: string;
  toothNumber: string;
  day: string | null;
  base: number;
  percent: number;
  amount: number;
}

/**
 * La foto del recibo que firma el profesional (`commission_receipt_requests.
 * content`): se congela al pedir la conformidad y su SHA-256 se guarda al
 * lado. Versionada para poder cambiar la forma sin romper las firmadas.
 */
export interface CommissionReceiptContent {
  version: 1;
  clinicName: string;
  professionalName: string;
  settlementId: string;
  period: { from: string; to: string };
  payment: {
    id: string;
    paidOn: string;
    method: PaymentMethod;
    reference: string | null;
    currency: string;
    amount: number;
    locationName: string;
  };
  lines: ReceiptLine[];
  /** Formato y zona de la sede principal (fechas y horas de la página y el PDF). */
  format: {
    locale: string | null;
    hourCycle: string | null;
    timeZone: string | null;
  };
}

export function receiptLineOf(line: DocumentLine): ReceiptLine {
  return {
    kind: line.kind,
    patientInitials: line.patientInitials,
    catalogCode: line.catalogCode,
    catalogLabel: line.catalogLabel,
    toothNumber: line.toothNumber,
    day: line.day,
    base: line.base,
    percent: line.percent,
    amount: line.amount,
  };
}

/** La foto del recibo de un pago vivo de la liquidación. */
export function buildReceiptContent(
  source: SettlementDocumentSource,
  payment: CommissionPaymentView,
): CommissionReceiptContent {
  const covered = new Set(payment.lineIds);
  return {
    version: 1,
    clinicName: source.clinicName,
    professionalName: source.header.professionalName,
    settlementId: source.header.id,
    period: source.header.period,
    payment: {
      id: payment.id,
      paidOn: payment.paidOn,
      method: payment.method,
      reference: payment.reference,
      currency: payment.currency,
      amount: payment.amount,
      locationName: payment.location.name,
    },
    lines: source.lines.filter((l) => covered.has(l.id)).map(receiptLineOf),
    format: {
      locale: source.format.locale,
      hourCycle: source.format.hourCycle,
      timeZone: source.format.timeZone,
    },
  };
}

export function receiptContentHash(content: CommissionReceiptContent): string {
  return sha256Hex(canonicalJson(content));
}

// --- Modelo del PDF -----------------------------------------------------------

export interface DocumentRow {
  patient: string;
  procedure: string;
  date: string;
  base: string;
  percent: string;
  amount: string;
}

export interface DocumentSection {
  title: string;
  rows: DocumentRow[];
  totals: { label: string; value: string }[];
}

export interface DocumentSignature {
  /** PNG en base64, sin prefijo `data:`. */
  image: string;
  evidence: { label: string; value: string }[];
}

/** Lo que pinta el renderer: todo formateado y pintable (WinAnsi). */
export interface CommissionDocumentModel {
  title: string;
  clinicName: string;
  facts: { label: string; value: string }[];
  sections: DocumentSection[];
  notes: string[];
  signature: DocumentSignature | null;
  generatedAt: Date;
}

/**
 * El formato de la sede (DX-354): sin él, 409 `LOCATION_LOCALE_REQUIRED`
 * como el resto de documentos. `id` solo identifica la sede en el error.
 */
export function documentFormat(format: {
  id: string;
  locale: string | null;
  hourCycle: string | null;
}): RegionalFormat {
  return requireLocationFormat(format);
}

/** Importe con el código ISO (DX-528: nunca con símbolo). */
function moneyText(
  fmt: RegionalFormat,
  amount: number,
  currency: string,
): string {
  return toWinAnsi(moneyWithCode(amount, currency, fmt, null));
}

function pdfText(text: string): string {
  return toWinAnsi(text);
}

function procedureOf(line: ReceiptLine): string {
  const tooth = line.toothNumber ? ` · diente ${line.toothNumber}` : '';
  const adjust = line.kind === 'ADJUSTMENT' ? ' (ajuste)' : '';
  return `${line.catalogCode} ${line.catalogLabel}${tooth}${adjust}`;
}

function rowsOf(
  lines: readonly ReceiptLine[],
  currency: string,
  fmt: RegionalFormat,
): DocumentRow[] {
  return lines.map((line) => ({
    patient: pdfText(line.patientInitials),
    procedure: pdfText(procedureOf(line)),
    date: line.day ? fmt.civilDate(line.day) : '—',
    base: moneyText(fmt, line.base, currency),
    percent: pdfText(fmt.percent(line.percent)),
    amount: moneyText(fmt, line.amount, currency),
  }));
}

/** El PDF de la liquidación: todas sus líneas por moneda y el estado de pago. */
export function settlementDocumentModel(
  source: SettlementDocumentSource,
  now: Date,
): CommissionDocumentModel {
  const fmt = documentFormat(source.format);
  const state = settlementPaymentState(
    source.lines.map((l) => ({
      id: l.id,
      currency: l.currency,
      amount: l.amount,
      paymentId: l.paymentId,
    })),
  );
  const currencies = [...new Set(source.lines.map((l) => l.currency))].sort();
  const sections: DocumentSection[] = currencies.map((currency) => {
    const lines = source.lines.filter((l) => l.currency === currency);
    const money = (n: number) => moneyText(fmt, n, currency);
    const sum = (ls: DocumentLine[]) =>
      fromCents(ls.reduce((s, l) => s + toCents(l.amount), 0));
    const accrued = sum(lines.filter((l) => l.kind === 'ACCRUAL'));
    const adjustments = sum(lines.filter((l) => l.kind === 'ADJUSTMENT'));
    const cents = (pick: (l: DocumentLine) => number) =>
      fromCents(lines.reduce((s, l) => s + toCents(pick(l)), 0));
    const labCost = cents((l) => l.labCost);
    const cardFee = cents((l) => l.cardFee);
    const cur = state.currencies.find((c) => c.currency === currency);
    const totals = [
      { label: 'Devengado', value: money(accrued) },
      ...(adjustments !== 0
        ? [
            {
              label: 'Ajustes de liquidaciones anteriores',
              value: money(adjustments),
            },
          ]
        : []),
      ...(source.deductLabCost
        ? [
            {
              label: 'Laboratorio descontado de la base',
              value: money(labCost),
            },
          ]
        : []),
      ...(source.deductCardFee
        ? [{ label: 'Pasarela descontada de la base', value: money(cardFee) }]
        : []),
      { label: 'Deducciones', value: money(0) },
      { label: `Total ${currency}`, value: money(cur?.total ?? 0) },
      { label: 'Pagado', value: money(cur?.paid ?? 0) },
      { label: 'Pendiente', value: money(Math.max(cur?.pending ?? 0, 0)) },
    ];
    return {
      title: `Moneda: ${currency}`,
      rows: rowsOf(lines.map(receiptLineOf), currency, fmt),
      totals,
    };
  });
  const live = source.payments.filter((p) => p.voidedAt === null);
  const skipped = source.lines.filter(
    (l) => l.labCostSkippedCurrencies.length > 0,
  ).length;
  const notes = [
    deductionsNote(source),
    ...(skipped > 0
      ? [
          `${skipped === 1 ? '1 prestación tiene' : `${skipped} prestaciones tienen`} costo de laboratorio en otra moneda: no se convierte ni se descuenta.`,
        ]
      : []),
    'Cada moneda se liquida y se paga por separado, sin convertir.',
    ...live.map((p) =>
      pdfText(
        `Pago del ${fmt.civilDate(p.paidOn)}: ${moneyWithCode(p.amount, p.currency, fmt, null)} · ${PAYMENT_METHOD_LABELS[p.method]}${p.reference ? ` · Ref. ${p.reference}` : ''} · ${p.location.name}`,
      ),
    ),
    'Pacientes identificados solo por sus iniciales.',
  ].map(pdfText);
  const tz = source.format.timeZone;
  return {
    title: 'Liquidación de honorarios',
    clinicName: pdfText(source.clinicName),
    facts: [
      { label: 'Profesional', value: pdfText(source.header.professionalName) },
      {
        label: 'Período',
        value: `${fmt.civilDate(source.header.period.from)} al ${fmt.civilDate(source.header.period.to)}`,
      },
      {
        label: 'Base',
        value: source.basis === 'COLLECTED' ? 'Lo cobrado' : 'Lo producido',
      },
      {
        label: 'Cerrada el',
        value: tz
          ? fmt.date(source.closedAt, tz)
          : source.closedAt.toISOString().slice(0, 10),
      },
      { label: 'Estado', value: PAYMENT_STATUS_LABELS[state.status] },
    ],
    sections,
    notes,
    signature: null,
    generatedAt: now,
  };
}

export interface SignedReceiptEvidence {
  signerName: string;
  signature: string;
  signedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  contentHash: string;
  receiptHash: string;
}

/** El recibo de un pago y, si se firmó, la conformidad con sus evidencias. */
export function receiptDocumentModel(
  content: CommissionReceiptContent,
  signed: SignedReceiptEvidence | null,
  timeZone: string | null,
  now: Date,
): CommissionDocumentModel {
  const fmt = documentFormat({ id: content.payment.id, ...content.format });
  const currency = content.payment.currency;
  const money = (n: number) => moneyText(fmt, n, currency);
  const when = (d: Date) =>
    timeZone
      ? fmt.dateTime(d, timeZone)
      : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return {
    title: signed
      ? 'Recibo de honorarios · Recibido conforme'
      : 'Recibo de pago de honorarios',
    clinicName: pdfText(content.clinicName),
    facts: [
      { label: 'Profesional', value: pdfText(content.professionalName) },
      {
        label: 'Período',
        value: `${fmt.civilDate(content.period.from)} al ${fmt.civilDate(content.period.to)}`,
      },
      { label: 'Fecha del pago', value: fmt.civilDate(content.payment.paidOn) },
      { label: 'Medio', value: PAYMENT_METHOD_LABELS[content.payment.method] },
      ...(content.payment.reference
        ? [{ label: 'Referencia', value: pdfText(content.payment.reference) }]
        : []),
      { label: 'Sede', value: pdfText(content.payment.locationName) },
      { label: 'Importe pagado', value: money(content.payment.amount) },
    ],
    sections: [
      {
        title: `Prestaciones pagadas (${currency})`,
        rows: rowsOf(content.lines, currency, fmt),
        totals: [
          { label: 'Deducciones', value: money(0) },
          { label: `Total ${currency}`, value: money(content.payment.amount) },
        ],
      },
    ],
    notes: [
      RECEIPT_BASE_NOTE,
      'Pacientes identificados solo por sus iniciales.',
    ].map(pdfText),
    signature: signed
      ? {
          image: signed.signature,
          evidence: [
            {
              label: 'Firmado por',
              value: pdfText(signed.signerName),
            },
            { label: 'Fecha y hora', value: pdfText(when(signed.signedAt)) },
            { label: 'IP', value: pdfText(signed.ipAddress ?? '—') },
            {
              label: 'Navegador',
              value: pdfText((signed.userAgent ?? '—').slice(0, 200)),
            },
            { label: 'Huella del recibo (SHA-256)', value: signed.contentHash },
            {
              label: 'Huella de la firma (SHA-256)',
              value: signed.receiptHash,
            },
          ],
        }
      : null,
    generatedAt: signed?.signedAt ?? now,
  };
}

/** Lo que ve el profesional en el enlace público (sin nada clínico). */
export interface PublicReceiptView {
  status: 'PENDING' | 'SIGNED';
  content: CommissionReceiptContent;
  expiresAt: Date;
  signedAt: Date | null;
  signerName: string | null;
}

export type ReceiptTimeZone = DocumentFormat['timeZone'];
