import type { ClinicCountry } from '@prisma/client';

/**
 * ¿Tiene una atención los datos que pide el Resumen Digital de Atención (RDA,
 * Res. 1888/2025, Colombia)? DX-212 solo lo COMPRUEBA: no genera el Bundle
 * FHIR ni envía nada al Ministerio.
 */
export type RdaMissingCode =
  | 'PATIENT_DOCUMENT'
  | 'PRINCIPAL_DIAGNOSIS'
  | 'PROCEDURE_CUPS'
  | 'LOCATION_REPS'
  | 'AUTHOR_LICENSE';

export interface RdaMissingItem {
  code: RdaMissingCode;
  /** Qué falta, en español, para la lista de la ficha. */
  label: string;
  /**
   * Dónde se completa: paciente, ítem del catálogo, sede o usuario autor.
   * `null` si no hay a quién señalar (diagnóstico; evolución sin autor).
   */
  resourceId: string | null;
}

/** Dato que hoy no se puede tener y NO bloquea (`ready` no lo cuenta). */
export interface RdaPendingItem {
  code: 'CLINIC_TAX_ID';
  label: string;
  reason: string;
}

export interface RdaReadiness {
  /** Sede fuera de Colombia: el RDA no aplica y no hay chip. */
  notApplicable: boolean;
  ready: boolean;
  missing: RdaMissingItem[];
  pending: RdaPendingItem[];
}

export interface RdaPerformedItem {
  catalogItemId: string;
  name: string;
  cupsCode: string | null;
}

/** Lo que el repositorio reúne de la atención (todo bajo RLS). */
export interface RdaFacts {
  country: ClinicCountry;
  location: { id: string; name: string; repsHabilitationCode: string | null };
  patient: { id: string; docNumber: string | null };
  hasPrincipalDiagnosis: boolean;
  /** Procedimientos hechos en esa atención (odontograma, sin anulados). */
  performedItems: RdaPerformedItem[];
  author: {
    userId: string | null;
    name: string | null;
    professionalLicense: string | null;
  };
}

/** NIT/razón social de la clínica: llegan con DX-019. */
const TAX_ID_PENDING: RdaPendingItem = {
  code: 'CLINIC_TAX_ID',
  label: 'NIT de la clínica',
  reason: 'pendiente de DX-019',
};

const blank = (value: string | null): boolean => !value || value.trim() === '';

export function computeRdaReadiness(facts: RdaFacts): RdaReadiness {
  if (facts.country !== 'CO') {
    return { notApplicable: true, ready: false, missing: [], pending: [] };
  }
  const missing: RdaMissingItem[] = [];
  if (blank(facts.patient.docNumber)) {
    missing.push({
      code: 'PATIENT_DOCUMENT',
      label: 'Documento de identidad del paciente',
      resourceId: facts.patient.id,
    });
  }
  if (!facts.hasPrincipalDiagnosis) {
    missing.push({
      code: 'PRINCIPAL_DIAGNOSIS',
      label: 'Diagnóstico principal (CIE-10)',
      resourceId: null,
    });
  }
  const reported = new Set<string>();
  for (const item of facts.performedItems) {
    if (!blank(item.cupsCode) || reported.has(item.catalogItemId)) continue;
    reported.add(item.catalogItemId);
    missing.push({
      code: 'PROCEDURE_CUPS',
      label: `Código CUPS de «${item.name}»`,
      resourceId: item.catalogItemId,
    });
  }
  if (blank(facts.location.repsHabilitationCode)) {
    missing.push({
      code: 'LOCATION_REPS',
      label: `Código de habilitación (REPS) de «${facts.location.name}»`,
      resourceId: facts.location.id,
    });
  }
  if (blank(facts.author.professionalLicense)) {
    missing.push({
      code: 'AUTHOR_LICENSE',
      label: facts.author.userId
        ? `Registro profesional de ${facts.author.name ?? 'el autor'}`
        : 'Registro profesional del autor (la evolución no tiene autor)',
      resourceId: facts.author.userId,
    });
  }
  return {
    notApplicable: false,
    ready: missing.length === 0,
    missing,
    pending: [TAX_ID_PENDING],
  };
}
