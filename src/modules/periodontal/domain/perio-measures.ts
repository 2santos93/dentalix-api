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
export const MOBILITY_MAX = 3;
/** 32 dientes x 6 sitios. */
export const MAX_SITES_PER_REQUEST = 192;
export const MAX_TEETH_PER_REQUEST = 32;

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
 * Índices del examen: % BOP, % placa y nº de sitios con sondaje ≥4 y ≥6 mm,
 * EXCLUYENDO los dientes omitidos (ausentes / no sondables).
 */
export function computePerioIndices(
  sites: readonly PerioSiteMeasure[],
  teeth: readonly PerioToothMeasure[],
): PerioIndices {
  const skipped = new Set(
    teeth.filter((t) => t.skipped).map((t) => t.toothFdi),
  );
  const examined = sites.filter(
    (s) => !skipped.has(s.toothFdi) && isExamined(s),
  );
  const total = examined.length;
  return {
    sitesExamined: total,
    bopPercent: percent(examined.filter((s) => s.bleeding).length, total),
    plaquePercent: percent(examined.filter((s) => s.plaque).length, total),
    sites4mmOrMore: examined.filter((s) => (s.probingMm ?? 0) >= 4).length,
    sites6mmOrMore: examined.filter((s) => (s.probingMm ?? 0) >= 6).length,
  };
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
