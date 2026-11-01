/**
 * DX-019: los datos fiscales y de contacto de la clínica. Recibo, receta y
 * presupuesto aceptado los CONGELAN al emitirse y se reimprimen con esa foto;
 * uno sin foto se imprime sin datos, nunca con los de hoy. El estado de cuenta
 * (se genera al pedirlo) y el presupuesto sin aceptar los leen en vivo. Texto
 * libre, sin formato por país; `taxIdLabel` null = el nombre genérico (la web).
 */
export interface ClinicFiscalData {
  legalName: string | null;
  taxIdLabel: string | null;
  taxId: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
}

/** Columnas de `tenants` que hay que leer (`select`). */
export const CLINIC_FISCAL_SELECT = {
  legalName: true,
  taxIdLabel: true,
  taxId: true,
  fiscalAddress: true,
  contactEmail: true,
  contactPhone: true,
} as const;

export interface ClinicFiscalRow {
  legalName: string | null;
  taxIdLabel: string | null;
  taxId: string | null;
  fiscalAddress: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

export const EMPTY_CLINIC_FISCAL: ClinicFiscalData = {
  legalName: null,
  taxIdLabel: null,
  taxId: null,
  address: null,
  email: null,
  phone: null,
};

export function clinicFiscalOf(
  row: ClinicFiscalRow | null | undefined,
): ClinicFiscalData {
  if (!row) return EMPTY_CLINIC_FISCAL;
  return {
    legalName: row.legalName,
    taxIdLabel: row.taxIdLabel,
    taxId: row.taxId,
    address: row.fiscalAddress,
    email: row.contactEmail,
    phone: row.contactPhone,
  };
}

/** Sin ningún dato, nada que congelar: `null`. */
export function clinicFiscalToFreeze(
  fiscal: ClinicFiscalData,
): ClinicFiscalData | null {
  return Object.values(fiscal).some((v) => v !== null) ? fiscal : null;
}

/** Array de orden fijo para sellarlo en un hash. */
export function clinicFiscalHashFields(
  fiscal: ClinicFiscalData,
): (string | null)[] {
  return [
    fiscal.legalName,
    fiscal.taxIdLabel,
    fiscal.taxId,
    fiscal.address,
    fiscal.email,
    fiscal.phone,
  ];
}

/** Lee una foto guardada (jsonb); lo que no tenga la forma, `null`. */
export function readClinicFiscal(value: unknown): ClinicFiscalData | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const text = (key: string) =>
    typeof r[key] === 'string' ? (r[key] as string) : null;
  return {
    legalName: text('legalName'),
    taxIdLabel: text('taxIdLabel'),
    taxId: text('taxId'),
    address: text('address'),
    email: text('email'),
    phone: text('phone'),
  };
}
