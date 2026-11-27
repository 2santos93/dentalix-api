import { PerioSite } from '@prisma/client';
import type {
  PerioIndices,
  PerioSiteMeasure,
  PerioToothMeasure,
} from './entities/perio-exam.entity';

export const PERIO_SITES: readonly PerioSite[] = [
  PerioSite.MB,
  PerioSite.B,
  PerioSite.DB,
  PerioSite.ML,
  PerioSite.L,
  PerioSite.DL,
];

export const PROBING_RANGE = { min: 0, max: 19 } as const;
export const RECESSION_RANGE = { min: -5, max: 19 } as const;
export const FURCATION_MAX = 3;

/**
 * DX-066: sitios donde la furca tiene sentido. Molares superiores (16–18,
 * 26–28): vestibular (B) y las dos entradas palatinas, mesiopalatina (MP, que
 * se guarda en el sitio ML) y distopalatina (DP, en DL). Molares inferiores
 * (36–38, 46–48): vestibular (B) y lingual (L). En el resto de dientes no hay
 * furca que registrar.
 */
export const UPPER_MOLAR_FURCATION_SITES: readonly PerioSite[] = [
  PerioSite.B,
  PerioSite.ML,
  PerioSite.DL,
];
export const LOWER_MOLAR_FURCATION_SITES: readonly PerioSite[] = [
  PerioSite.B,
  PerioSite.L,
];

/** Sitios del diente donde se puede registrar furca (vacío: ninguno). */
export function furcationSites(fdi: number): readonly PerioSite[] {
  if (!isPermanentFdi(fdi) || fdi % 10 < 6) return [];
  const quadrant = Math.floor(fdi / 10);
  return quadrant <= 2
    ? UPPER_MOLAR_FURCATION_SITES
    : LOWER_MOLAR_FURCATION_SITES;
}

export const FURCATION_SITE_MESSAGE =
  'la furca solo se registra en molares: superiores en B, MP (sitio ML) y DP (sitio DL); inferiores en B y L';

/**
 * DX-066: umbrales de sondaje de la clínica. `pdAlertMm` (4 de fábrica) marca
 * la bolsa en alerta y `pdSevereMm` (6) la severa; colorean la carta y cuentan
 * en los índices (`sitesAlertOrMore`, `sitesSevereOrMore`). Alerta < severo.
 */
export interface PerioThresholds {
  pdAlertMm: number;
  pdSevereMm: number;
}

export const DEFAULT_PERIO_THRESHOLDS: PerioThresholds = {
  pdAlertMm: 4,
  pdSevereMm: 6,
};
export const PD_ALERT_RANGE = { min: 2, max: 10 } as const;
export const PD_SEVERE_RANGE = { min: 3, max: 12 } as const;

export const PERIO_THRESHOLDS_MESSAGES = {
  alert: `El umbral de alerta debe ser un entero entre ${PD_ALERT_RANGE.min} y ${PD_ALERT_RANGE.max} mm`,
  severe: `El umbral severo debe ser un entero entre ${PD_SEVERE_RANGE.min} y ${PD_SEVERE_RANGE.max} mm`,
  order: 'El umbral de alerta debe ser menor que el severo',
} as const;

/** Errores en español (vacío si los umbrales son válidos). */
export function validatePerioThresholds(input: {
  pdAlertMm: unknown;
  pdSevereMm: unknown;
}): string[] {
  const errors: string[] = [];
  const alertOk = isIntIn(input.pdAlertMm, PD_ALERT_RANGE);
  const severeOk = isIntIn(input.pdSevereMm, PD_SEVERE_RANGE);
  if (!alertOk) errors.push(PERIO_THRESHOLDS_MESSAGES.alert);
  if (!severeOk) errors.push(PERIO_THRESHOLDS_MESSAGES.severe);
  if (
    alertOk &&
    severeOk &&
    (input.pdAlertMm as number) >= (input.pdSevereMm as number)
  ) {
    errors.push(PERIO_THRESHOLDS_MESSAGES.order);
  }
  return errors;
}

function isIntIn(
  value: unknown,
  range: { min: number; max: number },
): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= range.min &&
    value <= range.max
  );
}

/** Código de auditoría de los umbrales (`PD_A4_S6`). */
export function perioThresholdsCode(t: PerioThresholds): string {
  return `PD_A${t.pdAlertMm}_S${t.pdSevereMm}`;
}
export const MOBILITY_MAX = 3;
/** 32 dientes x 6 sitios. */
export const MAX_SITES_PER_REQUEST = 192;
export const MAX_TEETH_PER_REQUEST = 32;
/**
 * Tope del histórico (DX-103): los N exámenes más recientes. A dos o tres
 * exámenes al año son décadas de historia; documentado en Swagger.
 */
export const PERIO_LIST_MAX = 100;

/** Bitmask persistido en `perio_site_measures.flags`. */
export const PERIO_FLAG = { BOP: 1, SUP: 2, PLAQ: 4, CALC: 8 } as const;

type SiteFlags = Pick<
  PerioSiteMeasure,
  'bleeding' | 'suppuration' | 'plaque' | 'calculus'
>;

export function encodeFlags(flags: SiteFlags): number {
  return (
    (flags.bleeding ? PERIO_FLAG.BOP : 0) |
    (flags.suppuration ? PERIO_FLAG.SUP : 0) |
    (flags.plaque ? PERIO_FLAG.PLAQ : 0) |
    (flags.calculus ? PERIO_FLAG.CALC : 0)
  );
}

export function decodeFlags(mask: number): SiteFlags {
  return {
    bleeding: (mask & PERIO_FLAG.BOP) !== 0,
    suppuration: (mask & PERIO_FLAG.SUP) !== 0,
    plaque: (mask & PERIO_FLAG.PLAQ) !== 0,
    calculus: (mask & PERIO_FLAG.CALC) !== 0,
  };
}

/** Dentición permanente FDI: cuadrantes 1–4, dientes 1–8. */
export function isPermanentFdi(fdi: number): boolean {
  if (!Number.isInteger(fdi)) return false;
  const quadrant = Math.floor(fdi / 10);
  const tooth = fdi % 10;
  return quadrant >= 1 && quadrant <= 4 && tooth >= 1 && tooth <= 8;
}

/**
 * NIC / CAL = sondaje + recesión (convención: recesión positiva = margen
 * apical a la UAC). Sin recesión registrada se asume margen en la UAC (0).
 * Sin sondaje no hay NIC. Nunca negativo.
 */
export function calMm(
  probingMm: number | null,
  recessionMm: number | null,
): number | null {
  if (probingMm === null) return null;
  return Math.max(0, probingMm + (recessionMm ?? 0));
}

/** Un sitio cuenta como examinado si tiene sondaje o alguna marca. */
function isExamined(site: PerioSiteMeasure): boolean {
  return (
    site.probingMm !== null ||
    site.bleeding ||
    site.suppuration ||
    site.plaque ||
    site.calculus
  );
}

function percent(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/**
 * Conteos de los que salen los índices. El listado (DX-103) los calcula en la
 * base para no traer las medidas; el detalle, aquí con `countPerioSites`. Los
 * porcentajes salen SIEMPRE de `indicesFromCounts`, así que los dos caminos
 * redondean igual.
 */
export interface PerioSiteCounts {
  /** Sitios con sondaje o alguna marca, sin dientes omitidos. */
  sitesExamined: number;
  bleedingSites: number;
  plaqueSites: number;
  sites4mmOrMore: number;
  sites6mmOrMore: number;
  /** DX-066: sitios con sondaje ≥ el umbral de alerta de la clínica. */
  sitesAlertOrMore: number;
  /** DX-066: sitios con sondaje ≥ el umbral severo de la clínica. */
  sitesSevereOrMore: number;
}

/**
 * Conteos del examen EXCLUYENDO los dientes omitidos (ausentes / no
 * sondables). Un sitio cuenta si tiene sondaje o alguna marca.
 */
export function countPerioSites(
  sites: readonly PerioSiteMeasure[],
  teeth: readonly PerioToothMeasure[],
  thresholds: PerioThresholds = DEFAULT_PERIO_THRESHOLDS,
): PerioSiteCounts {
  const skipped = new Set(
    teeth.filter((t) => t.skipped).map((t) => t.toothFdi),
  );
  const examined = sites.filter(
    (s) => !skipped.has(s.toothFdi) && isExamined(s),
  );
  return {
    sitesExamined: examined.length,
    bleedingSites: examined.filter((s) => s.bleeding).length,
    plaqueSites: examined.filter((s) => s.plaque).length,
    sites4mmOrMore: examined.filter((s) => (s.probingMm ?? 0) >= 4).length,
    sites6mmOrMore: examined.filter((s) => (s.probingMm ?? 0) >= 6).length,
    sitesAlertOrMore: examined.filter(
      (s) => (s.probingMm ?? 0) >= thresholds.pdAlertMm,
    ).length,
    sitesSevereOrMore: examined.filter(
      (s) => (s.probingMm ?? 0) >= thresholds.pdSevereMm,
    ).length,
  };
}

/** % BOP y % placa (1 decimal) a partir de los conteos. */
export function indicesFromCounts(counts: PerioSiteCounts): PerioIndices {
  const total = counts.sitesExamined;
  return {
    sitesExamined: total,
    bopPercent: percent(counts.bleedingSites, total),
    plaquePercent: percent(counts.plaqueSites, total),
    sites4mmOrMore: counts.sites4mmOrMore,
    sites6mmOrMore: counts.sites6mmOrMore,
    sitesAlertOrMore: counts.sitesAlertOrMore,
    sitesSevereOrMore: counts.sitesSevereOrMore,
  };
}

/**
 * Índices del examen: % BOP, % placa, nº de sitios con sondaje ≥4 y ≥6 mm y
 * ≥ los umbrales de la clínica, EXCLUYENDO los dientes omitidos (ausentes /
 * no sondables).
 */
export function computePerioIndices(
  sites: readonly PerioSiteMeasure[],
  teeth: readonly PerioToothMeasure[],
  thresholds: PerioThresholds = DEFAULT_PERIO_THRESHOLDS,
): PerioIndices {
  return indicesFromCounts(countPerioSites(sites, teeth, thresholds));
}

function inRange(
  value: number | null,
  min: number,
  max: number,
): value is number | null {
  return (
    value === null || (Number.isInteger(value) && value >= min && value <= max)
  );
}

const INVALID_TOOTH = (fdi: number) =>
  `Diente ${fdi} no es un diente permanente válido (FDI 11–48)`;

/**
 * Valida un lote de medidas. Devuelve la lista de errores en español (vacía si
 * todo es válido) para que el 400 diga exactamente qué celda está mal.
 */
export function validatePerioMeasures(input: {
  sites: readonly PerioSiteMeasure[];
  teeth: readonly PerioToothMeasure[];
}): string[] {
  const errors: string[] = [];
  const seenSites = new Set<string>();
  for (const s of input.sites) {
    if (!isPermanentFdi(s.toothFdi)) {
      errors.push(INVALID_TOOTH(s.toothFdi));
      continue;
    }
    if (!PERIO_SITES.includes(s.site)) {
      errors.push(
        `Diente ${s.toothFdi}: sitio «${String(s.site)}» no válido (${PERIO_SITES.join(', ')})`,
      );
      continue;
    }
    const where = `Diente ${s.toothFdi}, sitio ${s.site}`;
    const key = `${s.toothFdi}:${s.site}`;
    if (seenSites.has(key)) {
      errors.push(`${where}: está repetido`);
      continue;
    }
    seenSites.add(key);
    if (!inRange(s.probingMm, PROBING_RANGE.min, PROBING_RANGE.max)) {
      errors.push(
        `${where}: el sondaje debe ser un entero entre ${PROBING_RANGE.min} y ${PROBING_RANGE.max} mm`,
      );
    }
    if (!inRange(s.recessionMm, RECESSION_RANGE.min, RECESSION_RANGE.max)) {
      errors.push(
        `${where}: la recesión debe ser un entero entre ${RECESSION_RANGE.min} y ${RECESSION_RANGE.max} mm`,
      );
    }
    if (!inRange(s.furcation, 0, FURCATION_MAX)) {
      errors.push(`${where}: la furca debe ser 0, 1, 2 o 3`);
    } else if (
      s.furcation !== null &&
      !furcationSites(s.toothFdi).includes(s.site)
    ) {
      errors.push(`${where}: ${FURCATION_SITE_MESSAGE}`);
    }
  }
  const seenTeeth = new Set<number>();
  for (const t of input.teeth) {
    if (!isPermanentFdi(t.toothFdi)) {
      errors.push(INVALID_TOOTH(t.toothFdi));
      continue;
    }
    if (seenTeeth.has(t.toothFdi)) {
      errors.push(`Diente ${t.toothFdi}: está repetido`);
      continue;
    }
    seenTeeth.add(t.toothFdi);
    if (!inRange(t.mobility, 0, MOBILITY_MAX)) {
      errors.push(`Diente ${t.toothFdi}: la movilidad debe ser 0, 1, 2 o 3`);
    }
  }
  return errors;
}

/** Un sitio sin ningún dato: no se muestra ni cuenta en los índices. */
export function isEmptySite(site: PerioSiteMeasure): boolean {
  return (
    site.probingMm === null &&
    site.recessionMm === null &&
    site.furcation === null &&
    encodeFlags(site) === 0
  );
}

/** Un diente sin movilidad y no omitido no aporta nada: no se muestra. */
export function isEmptyTooth(tooth: PerioToothMeasure): boolean {
  return tooth.mobility === null && !tooth.skipped;
}

/** `YYYY-MM-DD` que existe en el calendario (rechaza 2026-02-31). */
export function isValidCivilDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
