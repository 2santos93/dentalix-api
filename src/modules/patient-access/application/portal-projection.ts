import type { AccountStatement } from '../../account-statement/domain/entities/account-statement.entity';
import type { PlanQuoteDocument } from '../../treatment-plans/application/use-cases/plan-quote.use-cases';
import type { ClinicFiscalData } from '../../../shared/clinic/clinic-fiscal';

/** Los datos fiscales y de contacto que la clínica imprime en sus documentos. */
function fiscalOf(f: ClinicFiscalData): ClinicFiscalData {
  return {
    legalName: f.legalName,
    taxIdLabel: f.taxIdLabel,
    taxId: f.taxId,
    address: f.address,
    email: f.email,
    phone: f.phone,
  };
}

/**
 * DX-101 (revisión de seguridad): lo que el portal del paciente devuelve se
 * construye campo a campo, con LISTA BLANCA. Nunca se reenvía el objeto del
 * personal con `...`: un campo nuevo del personal (evidencias, autores, notas,
 * ids internos) no llega al paciente salvo que se añada aquí a propósito.
 *
 * Solo lo que el documento impreso del paciente ya enseña (presupuesto de
 * DX-012 y estado de cuenta de DX-011) y lo que la página necesita para
 * agrupar o enlazar entre sí sus propias filas (ids de SUS planes, cuotas y
 * saldos migrados).
 */

// --- Presupuesto -------------------------------------------------------------

export interface PortalQuote {
  version: PlanQuoteDocument['version'];
  currency: string;
  clinicName: string;
  clinicLogoUrl: string | null;
  clinicFiscal: PlanQuoteDocument['clinicFiscal'];
  location: { name: string; address: string | null };
  regional: PlanQuoteDocument['regional'];
  patient: { name: string; document: string | null };
  professionalName: string | null;
  agreement: { name: string; payerName: string } | null;
  issuedOn: string;
  validUntil: string;
  validityDays: number;
  items: {
    toothNumber: string;
    surfaces: PlanQuoteDocument['items'][number]['surfaces'];
    procedure: string;
    quantity: number;
    unitPrice: number;
    discount: number;
    subtotal: number;
    listPrice: number | null;
    agreementName: string | null;
    listPriceCurrency: string | null;
  }[];
  totals: {
    currency: string;
    gross: number;
    discount: number;
    net: number;
    agreementSaving: number;
  }[];
  contentHash: string;
  /** De la aceptación, SOLO quién firmó, la firma y cuándo. */
  acceptance: {
    signerName: string;
    signature: string;
    acceptedAt: Date;
  } | null;
}

export function toPortalQuote(doc: PlanQuoteDocument): PortalQuote {
  return {
    version: doc.version,
    currency: doc.currency,
    clinicName: doc.clinicName,
    clinicLogoUrl: doc.clinicLogoUrl,
    clinicFiscal: doc.clinicFiscal ? fiscalOf(doc.clinicFiscal) : null,
    location: { name: doc.location.name, address: doc.location.address },
    regional: doc.regional
      ? {
          timeZone: doc.regional.timeZone,
          locale: doc.regional.locale,
          hourCycle: doc.regional.hourCycle,
        }
      : null,
    patient: { name: doc.patient.name, document: doc.patient.document },
    professionalName: doc.professionalName,
    agreement: doc.agreement
      ? { name: doc.agreement.name, payerName: doc.agreement.payerName }
      : null,
    issuedOn: doc.issuedOn,
    validUntil: doc.validUntil,
    validityDays: doc.validityDays,
    items: doc.items.map((i) => ({
      toothNumber: i.toothNumber,
      surfaces: [...i.surfaces],
      procedure: i.procedure,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      discount: i.discount,
      subtotal: i.subtotal,
      listPrice: i.listPrice,
      agreementName: i.agreementName,
      listPriceCurrency: i.listPriceCurrency,
    })),
    totals: doc.totals.map((t) => ({
      currency: t.currency,
      gross: t.gross,
      discount: t.discount,
      net: t.net,
      agreementSaving: t.agreementSaving,
    })),
    contentHash: doc.contentHash,
    acceptance: doc.acceptance
      ? {
          signerName: doc.acceptance.signerName,
          // Lista para un <img>, como en el presupuesto del personal.
          signature: `data:image/png;base64,${doc.acceptance.signature}`,
          acceptedAt: doc.acceptance.acceptedAt,
        }
      : null,
  };
}

// --- Estado de cuenta --------------------------------------------------------

type Summary = AccountStatement['summary'][number];
type PlanLine = AccountStatement['plans'][number];
type Installment = AccountStatement['installments'][number];
type Opening = AccountStatement['openingBalances'][number];

export interface PortalAccount {
  issuedAt: Date;
  clinic: AccountStatement['clinic'];
  regional: AccountStatement['regional'];
  patient: {
    firstName: string;
    lastName: string;
    docType: AccountStatement['patient']['docType'];
    docTypeLabel: string | null;
    docTypeName: string;
    docNumber: string | null;
  };
  /** A nombre de quién sale (paciente o responsable), sin su email. */
  addressee: { kind: 'PATIENT' | 'RESPONSIBLE'; name: string };
  range: { from: string | null; to: string | null };
  summary: Summary[];
  plans: Omit<PlanLine, 'paymentsWithoutRate'>[];
  movements: {
    paidAt: Date;
    paidOn: string;
    amount: number;
    currency: string;
    method: AccountStatement['movements'][number]['method'];
    paymentMethodName: string | null;
    reference: string | null;
    externalInvoiceNumber: string | null;
    splitLines: number | null;
    receiptNumber: string | null;
    locationName: string;
    treatmentPlanId: string | null;
    openingBalanceId: string | null;
    voided: boolean;
    voidedAt: Date | null;
  }[];
  installments: Installment[];
  openingBalances: (Omit<Opening, 'importBatchId' | 'concept'> & {
    concept: string;
  })[];
  rateProviderTimedOut: boolean;
}

export function toPortalAccount(s: AccountStatement): PortalAccount {
  return {
    issuedAt: s.issuedAt,
    clinic: {
      name: s.clinic.name,
      logoUrl: s.clinic.logoUrl,
      fiscal: fiscalOf(s.clinic.fiscal),
    },
    regional: s.regional
      ? {
          timeZone: s.regional.timeZone,
          locale: s.regional.locale,
          hourCycle: s.regional.hourCycle,
        }
      : null,
    patient: {
      firstName: s.patient.firstName,
      lastName: s.patient.lastName,
      docType: s.patient.docType,
      docTypeLabel: s.patient.docTypeLabel,
      docTypeName: s.patient.docTypeName,
      docNumber: s.patient.docNumber,
    },
    addressee: { kind: s.addressee.kind, name: s.addressee.name },
    range: { from: s.range.from, to: s.range.to },
    summary: s.summary.map((r) => ({
      currency: r.currency,
      budgeted: r.budgeted,
      openingBalance: r.openingBalance,
      openingPending: r.openingPending,
      paid: r.paid,
      creditMovements: r.creditMovements,
      balance: r.balance,
      convertedPaid: r.convertedPaid,
      convertedBalance: r.convertedBalance,
      overdueCount: r.overdueCount,
      overdueAmount: r.overdueAmount,
      nextInstallment: r.nextInstallment
        ? {
            treatmentPlanId: r.nextInstallment.treatmentPlanId,
            sequence: r.nextInstallment.sequence,
            dueDate: r.nextInstallment.dueDate,
            amount: r.nextInstallment.amount,
          }
        : null,
    })),
    plans: s.plans.map((p) => ({
      id: p.id,
      status: p.status,
      currency: p.currency,
      createdAt: p.createdAt,
      budgeted: p.budgeted,
      billable: p.billable,
      countsTowardsBalance: p.countsTowardsBalance,
      paid: p.paid,
      paidOtherCurrencies: p.paidOtherCurrencies.map((o) => ({
        currency: o.currency,
        amount: o.amount,
      })),
      creditMovements: p.creditMovements,
      balance: p.balance,
      rateProviderTimedOut: p.rateProviderTimedOut,
    })),
    movements: s.movements.map((m) => ({
      paidAt: m.paidAt,
      paidOn: m.paidOn,
      amount: m.amount,
      currency: m.currency,
      method: m.method,
      paymentMethodName: m.paymentMethod?.name ?? null,
      reference: m.reference,
      externalInvoiceNumber: m.externalInvoiceNumber,
      splitLines: m.splitLines,
      receiptNumber: m.receiptNumber,
      locationName: m.location.name,
      treatmentPlanId: m.treatmentPlanId,
      openingBalanceId: m.openingBalanceId,
      voided: m.voided,
      voidedAt: m.voidedAt,
    })),
    installments: s.installments.map((i) => ({
      paymentPlanId: i.paymentPlanId,
      treatmentPlanId: i.treatmentPlanId,
      currency: i.currency,
      kind: i.kind,
      sequence: i.sequence,
      dueDate: i.dueDate,
      amount: i.amount,
      covered: i.covered,
      outstanding: i.outstanding,
      status: i.status,
    })),
    openingBalances: s.openingBalances.map((o) => ({
      id: o.id,
      currency: o.currency,
      amount: o.amount,
      asOfDate: o.asOfDate,
      asOfDateApproximate: o.asOfDateApproximate,
      concept: o.concept ?? '',
      paid: o.paid,
      pending: o.pending,
    })),
    rateProviderTimedOut: s.rateProviderTimedOut,
  };
}
