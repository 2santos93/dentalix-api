/**
 * DX-019: los datos fiscales y de contacto de la clínica tal como los imprimen
 * el presupuesto, la receta y el estado de cuenta (el recibo los congela en
 * su foto, ver `receipt-snapshot.ts`). Texto libre, sin formato por país;
 * `taxIdLabel` null = el nombre genérico, que pone la web.
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
