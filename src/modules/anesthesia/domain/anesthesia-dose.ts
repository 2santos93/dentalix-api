import { findAllergyMatches } from '../../prescriptions/domain/allergy-match';

/**
 * Dosis de anestesia local en la evolución (DX-307). Lo calcula el SERVIDOR
 * al previsualizar y lo vuelve a calcular al guardar; la web solo lo enseña.
 *
 *  - mg de una línea = carpules × ml por carpule × concentración (%) × 10
 *    (una solución al 1 % tiene 10 mg/ml).
 *  - máximo de un anestésico = min(mg/kg × peso, tope absoluto en mg).
 *  - con varios anestésicos en la ventana, la fracción del máximo es
 *    la SUMA de mg_i / máximo_i (Malamed, cap. 18: las dosis de los
 *    anestésicos locales son aditivas).
 *  - ≥ 80 % → aviso; ≥ 100 % → bloqueo blando: se guarda solo con motivo.
 *  - sin peso no hay máximo por peso («Dosis máxima no calculada: falta el
 *    peso»), pero el tope absoluto en mg sigue valiendo.
 *
 * Los mg/kg, topes, concentraciones y volúmenes son DATOS del catálogo de la
 * clínica (`anesthetic_products`), nunca constantes de aquí: las fuentes de
 * los valores de ejemplo están en `sample-anesthetics.ts`.
 *
 * Versionado: `ANESTHESIA_DOSE_RULES_VERSION` va en cada registro. Cambiar un
 * umbral, una regla o un texto obliga a subir la versión.
 *  - V1 (DX-307): las líneas eran las de UNA evolución.
 *  - V2 (DX-418): las líneas son todas las del paciente a menos de 24 h de
 *    la administración, en cualquier evolución y sede de la clínica
 *    (`anesthesia-window.ts`).
 */
export const ANESTHESIA_DOSE_RULES_VERSION = 'ANESTHESIA_DOSE_V2';

/** Fracción del máximo desde la que se avisa. */
export const DOSE_WARNING_FRACTION = 0.8;
/** Fracción del máximo desde la que hace falta confirmar con motivo. */
export const DOSE_BLOCK_FRACTION = 1;
/** Paso y rango de carpules: admite medios y cuartos (dosis infantiles). */
export const CARPULE_STEP = 0.25;
export const CARPULES_MAX = 20;

/** Margen para comparar fracciones sin errores de coma flotante. */
const EPSILON = 1e-9;

const MALAMED =
  'Malamed, Handbook of Local Anesthesia (dosis máximas recomendadas); valores del catálogo de la clínica';

/** Valores del catálogo que usa el cálculo (copiados en cada registro). */
export interface AnestheticSnapshot {
  name: string;
  activeIngredient: string;
  concentrationPct: number;
  vasoconstrictor: string | null;
  mlPerCarpule: number;
  maxMgPerKg: number;
  maxAbsoluteMg: number;
}

export interface DoseLine {
  anesthetic: AnestheticSnapshot;
  carpules: number;
}

/** Lo que la anamnesis vigente aporta: alergias de la lista y la casilla. */
export interface AnesthesiaAnamnesis {
  allergens: string[];
  anestheticAllergyFlag: boolean;
}

export type DoseLevel = 'OK' | 'WARNING' | 'EXCEEDED' | 'NO_WEIGHT';
export type DoseAlertSeverity = 'BLOCKING' | 'INFO';

export interface DoseAlert {
  code: string;
  severity: DoseAlertSeverity;
  message: string;
  source: string;
}

export interface AnestheticDose {
  name: string;
  activeIngredient: string;
  concentrationPct: number;
  carpules: number;
  mg: number;
  /** null sin peso. */
  maxMg: number | null;
  /** % de su máximo, entero; null sin peso. */
  percent: number | null;
}

export interface AnesthesiaDoseSummary {
  rulesVersion: string;
  weightKg: number | null;
  totalMg: number;
  byAnesthetic: AnestheticDose[];
  /** Suma de fracciones × 100, entero; null sin peso. */
  percent: number | null;
  level: DoseLevel;
  alerts: DoseAlert[];
}

export interface DoseInput {
  lines: readonly DoseLine[];
  weightKg: number | null;
  /** null = el paciente no tiene anamnesis. */
  anamnesis: AnesthesiaAnamnesis | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const fmt = (n: number) => String(round1(n)).replace('.', ',');

/**
 * Fracción → % entero que se ENSEÑA, sin contradecir el nivel: redondear
 * 0,996 daría «100 %» con un simple aviso (y 0,796 «80 %» sin aviso). Bajo un
 * umbral el % se queda por debajo de él; desde el umbral, nunca por debajo.
 */
function percentOf(fraction: number): number {
  const rounded = Math.round(fraction * 100);
  for (const threshold of [DOSE_BLOCK_FRACTION, DOSE_WARNING_FRACTION]) {
    const limit = Math.round(threshold * 100);
    if (fraction + EPSILON >= threshold) return Math.max(rounded, limit);
    if (rounded >= limit) return limit - 1;
  }
  return rounded;
}

export function isValidCarpules(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (value < CARPULE_STEP || value > CARPULES_MAX) return false;
  const steps = value / CARPULE_STEP;
  return Math.abs(steps - Math.round(steps)) < EPSILON;
}

/** mg de `carpules` carpules, redondeado a 0,1 mg (lo que se guarda). */
export function lineMg(
  anesthetic: AnestheticSnapshot,
  carpules: number,
): number {
  return round1(
    carpules * anesthetic.mlPerCarpule * anesthetic.concentrationPct * 10,
  );
}

/** Máximo en mg para el peso: el menor entre el de mg/kg y el tope absoluto. */
export function maxDoseMg(
  anesthetic: AnestheticSnapshot,
  weightKg: number | null,
): number | null {
  if (weightKg === null) return null;
  return round1(
    Math.min(anesthetic.maxMgPerKg * weightKg, anesthetic.maxAbsoluteMg),
  );
}

/** Mismo anestésico = mismos valores del catálogo (una copia idéntica). */
function keyOf(a: AnestheticSnapshot): string {
  return [
    a.name,
    a.activeIngredient,
    a.concentrationPct,
    a.mlPerCarpule,
    a.maxMgPerKg,
    a.maxAbsoluteMg,
  ].join('|');
}

interface Group {
  anesthetic: AnestheticSnapshot;
  carpules: number;
  mg: number;
}

function groupLines(lines: readonly DoseLine[]): Group[] {
  const groups = new Map<string, Group>();
  for (const line of lines) {
    const key = keyOf(line.anesthetic);
    const group = groups.get(key) ?? {
      anesthetic: line.anesthetic,
      carpules: 0,
      mg: 0,
    };
    group.carpules += line.carpules;
    group.mg = round1(group.mg + lineMg(line.anesthetic, line.carpules));
    groups.set(key, group);
  }
  return [...groups.values()];
}

function allergyAlerts(
  groups: Group[],
  anamnesis: AnesthesiaAnamnesis | null,
): DoseAlert[] {
  if (anamnesis === null) {
    return [
      {
        code: 'NO_ANAMNESIS',
        severity: 'INFO',
        message:
          'Sin anamnesis vigente: no se han podido comprobar alergias a anestésicos.',
        source: 'Anamnesis del paciente',
      },
    ];
  }
  if (groups.length === 0) return [];
  const matches = findAllergyMatches(
    groups.map((g) => g.anesthetic.activeIngredient),
    anamnesis.allergens,
  );
  if (matches.length > 0) {
    const list = matches
      .map((m) => `${m.activeIngredient} (alergia anotada: ${m.allergen})`)
      .join('; ');
    return [
      {
        code: 'ALLERGY_ANESTHETIC',
        severity: 'BLOCKING',
        message: `Alergia en la anamnesis a un anestésico de la misma familia: ${list}.`,
        source: 'Anamnesis del paciente (lista de alergias)',
      },
    ];
  }
  if (anamnesis.anestheticAllergyFlag) {
    return [
      {
        code: 'ALLERGY_ANESTHETIC_FLAG',
        severity: 'BLOCKING',
        message:
          'La anamnesis marca alergia a anestésicos locales: confirma el anestésico antes de aplicarlo.',
        source: 'Anamnesis del paciente (casilla de alergia a anestésicos)',
      },
    ];
  }
  return [];
}

export function summarizeAnesthesiaDose(
  input: DoseInput,
): AnesthesiaDoseSummary {
  const { weightKg } = input;
  const groups = groupLines(input.lines);
  const totalMg = round1(groups.reduce((sum, g) => sum + g.mg, 0));
  const byAnesthetic: AnestheticDose[] = groups.map((g) => {
    const maxMg = maxDoseMg(g.anesthetic, weightKg);
    return {
      name: g.anesthetic.name,
      activeIngredient: g.anesthetic.activeIngredient,
      concentrationPct: g.anesthetic.concentrationPct,
      carpules: g.carpules,
      mg: g.mg,
      maxMg,
      percent: maxMg === null ? null : percentOf(g.mg / maxMg),
    };
  });

  const alerts: DoseAlert[] = [];
  let level: DoseLevel;
  let percent: number | null;

  if (weightKg === null) {
    percent = null;
    level = 'NO_WEIGHT';
    if (groups.length > 0) {
      alerts.push({
        code: 'WEIGHT_MISSING',
        severity: 'INFO',
        message: 'Dosis máxima no calculada: falta el peso.',
        source: MALAMED,
      });
    }
    // El tope absoluto no depende del peso: también suma fracciones.
    const absoluteFraction = groups.reduce(
      (sum, g) => sum + g.mg / g.anesthetic.maxAbsoluteMg,
      0,
    );
    if (absoluteFraction + EPSILON >= DOSE_BLOCK_FRACTION) {
      level = 'EXCEEDED';
      alerts.push({
        code: 'DOSE_OVER_ABSOLUTE',
        severity: 'BLOCKING',
        message: `Tope absoluto superado: ${fmt(totalMg)} mg (${percentOf(absoluteFraction)} % del tope en mg), aun sin conocer el peso.`,
        source: MALAMED,
      });
    }
  } else {
    const fraction = byAnesthetic.reduce(
      (sum, a) => sum + a.mg / (a.maxMg as number),
      0,
    );
    percent = percentOf(fraction);
    const maxLabel =
      byAnesthetic.length === 1
        ? `de ${fmt(byAnesthetic[0].maxMg as number)} mg (${percent} %)`
        : `(${percent} % de la suma de los máximos de cada anestésico)`;
    if (fraction + EPSILON >= DOSE_BLOCK_FRACTION) {
      level = 'EXCEEDED';
      alerts.push({
        code: 'DOSE_OVER_MAX',
        severity: 'BLOCKING',
        message: `Dosis máxima superada: ${fmt(totalMg)} mg ${maxLabel} para ${fmt(weightKg)} kg.`,
        source: MALAMED,
      });
    } else if (fraction + EPSILON >= DOSE_WARNING_FRACTION) {
      level = 'WARNING';
      alerts.push({
        code: 'DOSE_NEAR_MAX',
        severity: 'INFO',
        message: `Cerca de la dosis máxima: ${fmt(totalMg)} mg ${maxLabel} para ${fmt(weightKg)} kg.`,
        source: MALAMED,
      });
    } else {
      level = 'OK';
    }
  }

  alerts.push(...allergyAlerts(groups, input.anamnesis));
  return {
    rulesVersion: ANESTHESIA_DOSE_RULES_VERSION,
    weightKg,
    totalMg,
    byAnesthetic,
    percent,
    level,
    alerts,
  };
}

export function hasBlockingDoseAlerts(alerts: readonly DoseAlert[]): boolean {
  return alerts.some((a) => a.severity === 'BLOCKING');
}
