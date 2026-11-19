import type { PatientSourceKind } from '@prisma/client';
import { round2 } from '../../../shared/money/money';

/**
 * «Captación» (DX-172): pacientes nuevos del período por fuente («¿Cómo nos
 * conoció?») y lo cobrado a esos pacientes en el período, por moneda (sin
 * convertir), más los pacientes que más recomiendan.
 */

export const ACQUISITION_NO_SOURCE_LABEL = 'Sin dato';
export const ACQUISITION_TOP_REFERRERS = 10;

export interface CurrencyAmount {
  currency: string;
  amount: number;
}

/** Una fuente del catálogo (activa o no). */
export interface AcquisitionCatalogSource {
  id: string;
  name: string;
  kind: PatientSourceKind;
  isActive: boolean;
  sortOrder: number;
}

/** Lo que devuelve la consulta, por fuente (null = sin fuente). */
export interface AcquisitionSourceSums {
  sourceId: string | null;
  newPatients: number;
  payingPatients: number;
}

export interface AcquisitionSourceAmount {
  sourceId: string | null;
  currency: string;
  amount: number;
}

export interface AcquisitionReferrerSums {
  patientId: string;
  fullName: string;
  patientCode: string;
  referred: number;
}

export interface AcquisitionReferrerAmount {
  patientId: string;
  currency: string;
  amount: number;
}

export interface AcquisitionRow {
  sourceId: string | null;
  name: string;
  kind: PatientSourceKind | null;
  isActive: boolean | null;
  newPatients: number;
  payingPatients: number;
  collected: CurrencyAmount[];
}

export interface AcquisitionTopReferrer {
  patientId: string;
  fullName: string;
  patientCode: string;
  referred: number;
  collected: CurrencyAmount[];
}

export interface AcquisitionTotals {
  newPatients: number;
  payingPatients: number;
  collected: CurrencyAmount[];
}

export interface AcquisitionBody {
  rows: AcquisitionRow[];
  totals: AcquisitionTotals;
  topReferrers: AcquisitionTopReferrer[];
  currencies: string[];
  hasActivity: boolean;
}

function amounts(
  list: readonly { currency: string; amount: number }[],
): CurrencyAmount[] {
  const byCurrency = new Map<string, number>();
  for (const a of list) {
    byCurrency.set(a.currency, (byCurrency.get(a.currency) ?? 0) + a.amount);
  }
  return [...byCurrency.entries()]
    .map(([currency, amount]) => ({ currency, amount: round2(amount) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

function amountOf(list: readonly CurrencyAmount[]): number {
  return list.reduce((sum, a) => sum + a.amount, 0);
}

/**
 * Las filas de la tabla: cada fuente ACTIVA (también con 0, para ver lo que
 * no trae a nadie), las desactivadas que trajeron a alguien y «Sin dato» si
 * hay pacientes sin fuente. Orden: más pacientes nuevos, más cobrado (suma
 * simple, solo para desempatar), el orden del catálogo y el nombre; «Sin
 * dato» al final.
 */
export function buildAcquisition(
  catalog: readonly AcquisitionCatalogSource[],
  sums: readonly AcquisitionSourceSums[],
  sourceAmounts: readonly AcquisitionSourceAmount[],
  referrers: readonly AcquisitionReferrerSums[],
  referrerAmounts: readonly AcquisitionReferrerAmount[],
): AcquisitionBody {
  const sumsOf = new Map(sums.map((s) => [s.sourceId, s]));
  const amountsOf = (sourceId: string | null) =>
    amounts(sourceAmounts.filter((a) => a.sourceId === sourceId));

  const catalogRows: (AcquisitionRow & { sortOrder: number })[] = catalog
    .filter((s) => s.isActive || (sumsOf.get(s.id)?.newPatients ?? 0) > 0)
    .map((s) => ({
      sourceId: s.id,
      name: s.name,
      kind: s.kind,
      isActive: s.isActive,
      newPatients: sumsOf.get(s.id)?.newPatients ?? 0,
      payingPatients: sumsOf.get(s.id)?.payingPatients ?? 0,
      collected: amountsOf(s.id),
      sortOrder: s.sortOrder,
    }));
  catalogRows.sort(
    (a, b) =>
      b.newPatients - a.newPatients ||
      amountOf(b.collected) - amountOf(a.collected) ||
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }),
  );
  const rows: AcquisitionRow[] = catalogRows.map((row) => ({
    sourceId: row.sourceId,
    name: row.name,
    kind: row.kind,
    isActive: row.isActive,
    newPatients: row.newPatients,
    payingPatients: row.payingPatients,
    collected: row.collected,
  }));
  const none = sumsOf.get(null);
  if (none && none.newPatients > 0) {
    rows.push({
      sourceId: null,
      name: ACQUISITION_NO_SOURCE_LABEL,
      kind: null,
      isActive: null,
      newPatients: none.newPatients,
      payingPatients: none.payingPatients,
      collected: amountsOf(null),
    });
  }

  const totals: AcquisitionTotals = {
    newPatients: sums.reduce((n, s) => n + s.newPatients, 0),
    payingPatients: sums.reduce((n, s) => n + s.payingPatients, 0),
    collected: amounts(sourceAmounts),
  };
  const topReferrers = [...referrers]
    .sort(
      (a, b) =>
        b.referred - a.referred ||
        a.fullName.localeCompare(b.fullName, 'es', { sensitivity: 'base' }) ||
        a.patientId.localeCompare(b.patientId),
    )
    .slice(0, ACQUISITION_TOP_REFERRERS)
    .map((r) => ({
      ...r,
      collected: amounts(
        referrerAmounts.filter((a) => a.patientId === r.patientId),
      ),
    }));
  return {
    rows,
    totals,
    topReferrers,
    currencies: totals.collected.map((c) => c.currency),
    hasActivity: totals.newPatients > 0,
  };
}
