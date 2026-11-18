/**
 * DX-101 (revisión de seguridad): la LISTA BLANCA de claves que puede llevar
 * la respuesta del portal del paciente (`GET /public/patient-access/me`). Los
 * tests serializan la respuesta real y fallan si aparece cualquier clave
 * fuera de esta lista: un campo nuevo del personal (evidencias, autores,
 * notas, ids internos) no llega al paciente sin decidirlo aquí.
 *
 * Rutas con `[]` para los elementos de una lista.
 */
const QUOTE = [
  'version',
  'currency',
  'clinicName',
  'clinicLogoUrl',
  'clinicFiscal',
  'clinicFiscal.legalName',
  'clinicFiscal.taxIdLabel',
  'clinicFiscal.taxId',
  'clinicFiscal.address',
  'clinicFiscal.email',
  'clinicFiscal.phone',
  'location',
  'location.name',
  'location.address',
  'regional',
  'regional.timeZone',
  'regional.locale',
  'regional.hourCycle',
  'patient',
  'patient.name',
  'patient.document',
  'professionalName',
  'agreement',
  'agreement.name',
  'agreement.payerName',
  'issuedOn',
  'validUntil',
  'validityDays',
  'items',
  'items[].toothNumber',
  'items[].surfaces',
  'items[].procedure',
  'items[].quantity',
  'items[].unitPrice',
  'items[].discount',
  'items[].subtotal',
  'items[].listPrice',
  'items[].agreementName',
  'items[].listPriceCurrency',
  'totals',
  'totals[].currency',
  'totals[].gross',
  'totals[].discount',
  'totals[].net',
  'totals[].agreementSaving',
  'contentHash',
  'acceptance',
  'acceptance.signerName',
  'acceptance.signature',
  'acceptance.acceptedAt',
];

const ACCOUNT = [
  'issuedAt',
  'clinic',
  'clinic.name',
  'clinic.logoUrl',
  'clinic.fiscal',
  'clinic.fiscal.legalName',
  'clinic.fiscal.taxIdLabel',
  'clinic.fiscal.taxId',
  'clinic.fiscal.address',
  'clinic.fiscal.email',
  'clinic.fiscal.phone',
  'regional',
  'regional.timeZone',
  'regional.locale',
  'regional.hourCycle',
  'patient',
  'patient.firstName',
  'patient.lastName',
  'patient.docType',
  'patient.docTypeLabel',
  'patient.docTypeName',
  'patient.docNumber',
  'addressee',
  'addressee.kind',
  'addressee.name',
  'range',
  'range.from',
  'range.to',
  'summary',
  'summary[].currency',
  'summary[].budgeted',
  'summary[].openingBalance',
  'summary[].openingPending',
  'summary[].paid',
  'summary[].creditMovements',
  'summary[].balance',
  'summary[].convertedPaid',
  'summary[].convertedBalance',
  'summary[].overdueCount',
  'summary[].overdueAmount',
  'summary[].nextInstallment',
  'summary[].nextInstallment.treatmentPlanId',
  'summary[].nextInstallment.sequence',
  'summary[].nextInstallment.dueDate',
  'summary[].nextInstallment.amount',
  'plans',
  'plans[].id',
  'plans[].status',
  'plans[].currency',
  'plans[].createdAt',
  'plans[].budgeted',
  'plans[].billable',
  'plans[].countsTowardsBalance',
  'plans[].paid',
  'plans[].paidOtherCurrencies',
  'plans[].paidOtherCurrencies[].currency',
  'plans[].paidOtherCurrencies[].amount',
  'plans[].creditMovements',
  'plans[].balance',
  'plans[].rateProviderTimedOut',
  'movements',
  'movements[].paidAt',
  'movements[].paidOn',
  'movements[].amount',
  'movements[].currency',
  'movements[].method',
  'movements[].paymentMethodName',
  'movements[].reference',
  'movements[].externalInvoiceNumber',
  'movements[].splitLines',
  'movements[].receiptNumber',
  'movements[].locationName',
  'movements[].treatmentPlanId',
  'movements[].openingBalanceId',
  'movements[].voided',
  'movements[].voidedAt',
  'installments',
  'installments[].paymentPlanId',
  'installments[].treatmentPlanId',
  'installments[].currency',
  'installments[].kind',
  'installments[].sequence',
  'installments[].dueDate',
  'installments[].amount',
  'installments[].covered',
  'installments[].outstanding',
  'installments[].status',
  'openingBalances',
  'openingBalances[].id',
  'openingBalances[].currency',
  'openingBalances[].amount',
  'openingBalances[].asOfDate',
  'openingBalances[].asOfDateApproximate',
  'openingBalances[].concept',
  'openingBalances[].paid',
  'openingBalances[].pending',
  'rateProviderTimedOut',
];

export const PORTAL_QUOTE_KEYS: ReadonlySet<string> = new Set(QUOTE);
export const PORTAL_ACCOUNT_KEYS: ReadonlySet<string> = new Set(ACCOUNT);

export const PORTAL_RESPONSE_KEYS: ReadonlySet<string> = new Set([
  'clinicName',
  'patientFirstName',
  'minor',
  'scopes',
  'sessionExpiresAt',
  'appointments',
  'appointments[].id',
  'appointments[].start',
  'appointments[].end',
  'appointments[].status',
  'appointments[].typeName',
  'appointments[].providerName',
  'appointments[].location',
  'appointments[].location.name',
  'appointments[].location.address',
  'appointments[].location.timeZone',
  'appointments[].location.locale',
  'appointments[].location.hourCycle',
  'appointments[].confirmable',
  'plans',
  'plans[].id',
  'plans[].status',
  'plans[].optionGroupId',
  'plans[].optionLabel',
  // DX-101-bis: aceptar desde el portal.
  'plans[].acceptable',
  'plans[].validUntil',
  'plans[].contentHash',
  'plans[].acceptedAt',
  'plans[].quote',
  ...QUOTE.map((k) => `plans[].quote.${k}`),
  'account',
  ...ACCOUNT.map((k) => `account.${k}`),
]);

/**
 * DX-101-bis: la respuesta de aceptar (`POST …/me/plans/:planId/accept`): un
 * plan del portal, con la misma lista blanca que `plans[]` de `GET me`.
 */
export const PORTAL_PLAN_KEYS: ReadonlySet<string> = new Set(
  [...PORTAL_RESPONSE_KEYS]
    .filter((k) => k.startsWith('plans[].'))
    .map((k) => k.slice('plans[].'.length)),
);

/** Todas las rutas de claves de un valor JSON (`a.b[].c`). */
export function keyPaths(value: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) {
      for (const el of v) walk(el, `${path}[]`);
      return;
    }
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      for (const [k, child] of Object.entries(v)) {
        const p = path ? `${path}.${k}` : k;
        out.add(p);
        walk(child, p);
      }
    }
  };
  walk(value, prefix);
  return out;
}

/** Claves de `value` que NO están en la lista blanca. */
export function keysOutside(
  value: unknown,
  allowed: ReadonlySet<string>,
): string[] {
  return [...keyPaths(JSON.parse(JSON.stringify(value)))].filter(
    (k) => !allowed.has(k),
  );
}
