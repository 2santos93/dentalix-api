import { findAllergyMatches } from '../../prescriptions/domain/allergy-match';
import {
  AAPD_SOURCE,
  type DoseAdjustment,
  type DosePatient,
  doseAdjustment,
  EPINEPHRINE_SOURCE,
  epinephrineFromLabel,
  epinephrineMaxMg,
  NO_ADJUSTMENT,
  PEDIATRIC_AGE_LIMIT,
  UNKNOWN_PATIENT,
} from './anesthesia-limits';

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
 *  - V2 (DX-418): las líneas son todas las del paciente en la ventana de
 *    24 h que contiene la administración con más acumulado, en cualquier
 *    evolución y sede de la clínica (`anesthesia-window.ts`).
 *  - V3 (DX-420): máximo pediátrico (< 12 años) del catálogo, −30 % en
 *    menores de 6 meses y con sedación en las 24 h, edad mínima del fármaco
 *    y tope de epinefrina por cita (0,04 mg en el cardiópata)
 *    (`anesthesia-limits.ts`).
 */
export const ANESTHESIA_DOSE_RULES_VERSION = 'ANESTHESIA_DOSE_V3';

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
  /**
   * DX-420: mg/kg en menores de 12 años (null o ausente = el de adulto),
   * edad mínima en años (null = sin mínimo) y mg de epinefrina por carpule
   * (ausente en registros anteriores a DX-420: se deduce del texto del
   * vasoconstrictor; null = no se sabe).
   */
  pediatricMaxMgPerKg?: number | null;
  minAgeYears?: number | null;
  epinephrineMgPerCarpule?: number | null;
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
  /** DX-420: mg/kg usado (pediátrico o de adulto). */
  maxMgPerKg: number;
  /** De dónde sale ese máximo, para enseñarlo. */
  maxSource: string;
}

export type EpinephrineLevel = 'OK' | 'WARNING' | 'EXCEEDED';

/** DX-420: epinefrina acumulada en la ventana contra el tope por cita. */
export interface EpinephrineSummary {
  totalMg: number;
  maxMg: number;
  /** % del tope, entero (mismo redondeo que la dosis). */
  percent: number;
  /** Cardiopatía en la anamnesis; null sin anamnesis. */
  cardiac: boolean | null;
  level: EpinephrineLevel;
}

/** DX-420: «quedan X mg ≈ Y carpules» del anestésico que se va a poner. */
export interface DoseRemaining {
  name: string;
  mg: number;
  /** En cuartos de carpule, hacia abajo y por debajo del 100 %. */
  carpules: number;
  mlPerCarpule: number;
  /** Qué límite se agota antes (con la epinefrina, `mg` son los que caben con ella). */
  limitedBy: 'DOSE' | 'EPINEPHRINE';
  /** Epinefrina que queda hasta el tope, en mg. */
  epinephrineMg: number;
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
  /** DX-420: ajustes del máximo por edad y sedación. */
  adjustment: DoseAdjustment & { ageYears: number | null };
  epinephrine: EpinephrineSummary;
  /** Solo con una dosis nueva y peso; null si no. */
  remaining: DoseRemaining | null;
}

export interface DoseInput {
  lines: readonly DoseLine[];
  weightKg: number | null;
  /** null = el paciente no tiene anamnesis. */
  anamnesis: AnesthesiaAnamnesis | null;
  /**
   * DX-420: edad, sedación y cardiopatía. Sin él se calcula como un adulto
   * sano y no se avisa de lo que no se sabe (edad, cardiopatía): el caso de
   * uso siempre lo pasa.
   */
  patient?: DosePatient;
  /** DX-420: el anestésico de la dosis nueva (ya incluida en `lines`). */
  pending?: AnestheticSnapshot | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const fmt = (n: number) => String(round1(n)).replace('.', ',');
const fmtEpi = (n: number) => String(round4(n)).replace('.', ',');

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

/** mg/kg que aplica: el pediátrico del catálogo en menores de 12, si lo hay. */
export function maxMgPerKgFor(
  anesthetic: AnestheticSnapshot,
  adjustment: DoseAdjustment = NO_ADJUSTMENT,
): number {
  return adjustment.pediatric && anesthetic.pediatricMaxMgPerKg
    ? anesthetic.pediatricMaxMgPerKg
    : anesthetic.maxMgPerKg;
}

/**
 * Máximo en mg para el peso: el menor entre el de mg/kg y el tope absoluto,
 * por el factor de reducción (DX-420: lactante, sedación).
 */
export function maxDoseMg(
  anesthetic: AnestheticSnapshot,
  weightKg: number | null,
  adjustment: DoseAdjustment = NO_ADJUSTMENT,
): number | null {
  if (weightKg === null) return null;
  return round1(
    Math.min(
      maxMgPerKgFor(anesthetic, adjustment) * weightKg,
      anesthetic.maxAbsoluteMg,
    ) * adjustment.factor,
  );
}

/** mg de epinefrina por carpule: el del catálogo o, si falta, el del texto. */
export function epinephrinePerCarpule(
  anesthetic: AnestheticSnapshot,
): number | null {
  return anesthetic.epinephrineMgPerCarpule === undefined
    ? epinephrineFromLabel(anesthetic.vasoconstrictor, anesthetic.mlPerCarpule)
    : anesthetic.epinephrineMgPerCarpule;
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
    a.pediatricMaxMgPerKg ?? '',
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

/** Fuente del máximo de un anestésico, para enseñarla con él. */
function maxSourceOf(
  anesthetic: AnestheticSnapshot,
  adjustment: DoseAdjustment,
): string {
  const base =
    adjustment.pediatric && anesthetic.pediatricMaxMgPerKg
      ? `${AAPD_SOURCE}: ${fmt(anesthetic.pediatricMaxMgPerKg)} mg/kg en menores de ${PEDIATRIC_AGE_LIMIT} años`
      : MALAMED;
  return adjustment.factor < 1
    ? `${base}; reducido un ${Math.round((1 - adjustment.factor) * 100)} % (${AAPD_SOURCE})`
    : base;
}

/** Avisos de por qué el máximo no es el del prospecto (DX-420). */
function adjustmentAlerts(
  groups: Group[],
  adjustment: DoseAdjustment,
  patient: DosePatient | null,
  pending: AnestheticSnapshot | null,
): DoseAlert[] {
  const alerts: DoseAlert[] = [];
  if (groups.length === 0) return alerts;
  const pediatricGroups = groups.filter(
    (g) => g.anesthetic.pediatricMaxMgPerKg,
  );
  if (adjustment.pediatric && pediatricGroups.length > 0) {
    const list = pediatricGroups
      .map(
        (g) =>
          `${g.anesthetic.activeIngredient} ${fmt(g.anesthetic.pediatricMaxMgPerKg as number)} mg/kg`,
      )
      .join(', ');
    alerts.push({
      code: 'PEDIATRIC_MAX',
      severity: 'INFO',
      message: `Menor de ${PEDIATRIC_AGE_LIMIT} años (${patient?.ageYears} años): máximo pediátrico de ${list}.`,
      source: AAPD_SOURCE,
    });
  }
  if (adjustment.infant) {
    alerts.push({
      code: 'DOSE_REDUCED_INFANT',
      severity: 'INFO',
      message: `Máximo reducido un 30 %: menor de 6 meses (${patient?.ageMonths} meses).`,
      source: AAPD_SOURCE,
    });
  }
  if (adjustment.sedation) {
    alerts.push({
      code: 'DOSE_REDUCED_SEDATION',
      severity: 'INFO',
      message:
        'Máximo reducido un 30 %: hay sedación consciente registrada en las 24 h de la anestesia (depresor del sistema nervioso central).',
      source: AAPD_SOURCE,
    });
  }
  const ageDependent =
    pediatricGroups.length > 0 || (pending?.minAgeYears ?? null) !== null;
  if (patient === null) return alerts;
  if (patient.ageYears === null && ageDependent) {
    alerts.push({
      code: 'AGE_UNKNOWN',
      severity: 'INFO',
      message:
        'Sin fecha de nacimiento: se usan los máximos de adulto y no se comprueba la edad mínima del anestésico. Anótala en la ficha del paciente.',
      source: AAPD_SOURCE,
    });
  }
  const minAge = pending?.minAgeYears ?? null;
  if (
    pending &&
    minAge !== null &&
    patient.ageYears !== null &&
    patient.ageYears < minAge
  ) {
    alerts.push({
      code: 'AGE_BELOW_MINIMUM',
      severity: 'BLOCKING',
      message: `${pending.activeIngredient} no recomendada en menores de ${minAge} años (el paciente tiene ${patient.ageYears}).`,
      source: AAPD_SOURCE,
    });
  }
  return alerts;
}

/**
 * Epinefrina LÍNEA A LÍNEA, no por grupo: dos registros del mismo anestésico
 * (misma clave de dosis) pueden llevar distinta epinefrina por carpule si la
 * clínica la corrigió en el catálogo entre uno y otro, y el grupo solo
 * conserva la copia del primero.
 */
function summarizeEpinephrine(
  lines: readonly DoseLine[],
  anamnesis: AnesthesiaAnamnesis | null,
  patient: DosePatient | null,
): { summary: EpinephrineSummary; alerts: DoseAlert[] } {
  const alerts: DoseAlert[] = [];
  const unknown = new Set<string>();
  let totalMg = 0;
  for (const line of lines) {
    const perCarpule = epinephrinePerCarpule(line.anesthetic);
    if (perCarpule === null) {
      unknown.add(line.anesthetic.name);
    } else {
      totalMg += perCarpule * line.carpules;
    }
  }
  for (const name of unknown) {
    alerts.push({
      code: 'EPINEPHRINE_UNKNOWN',
      severity: 'INFO',
      message: `No se ha podido sumar la epinefrina de ${name}: falta su dilución o los mg por carpule en el catálogo.`,
      source: EPINEPHRINE_SOURCE,
    });
  }
  totalMg = round4(totalMg);
  const cardiac = anamnesis === null ? null : (patient?.cardiac ?? false);
  const maxMg = epinephrineMaxMg(cardiac);
  const fraction = totalMg / maxMg;
  const percent = percentOf(fraction);
  const who = cardiac === true ? 'cardiopatía en la anamnesis' : 'adulto sano';
  let level: EpinephrineLevel = 'OK';
  if (totalMg > 0 && fraction + EPSILON >= DOSE_BLOCK_FRACTION) {
    level = 'EXCEEDED';
    alerts.push({
      code: 'EPINEPHRINE_OVER_MAX',
      severity: 'BLOCKING',
      message: `Epinefrina por encima del tope: ${fmtEpi(totalMg)} mg de ${fmtEpi(maxMg)} mg por cita (${percent} %, ${who}).`,
      source: EPINEPHRINE_SOURCE,
    });
  } else if (totalMg > 0 && fraction + EPSILON >= DOSE_WARNING_FRACTION) {
    level = 'WARNING';
    alerts.push({
      code: 'EPINEPHRINE_NEAR_MAX',
      severity: 'INFO',
      message: `Epinefrina cerca del tope: ${fmtEpi(totalMg)} mg de ${fmtEpi(maxMg)} mg por cita (${percent} %, ${who}).`,
      source: EPINEPHRINE_SOURCE,
    });
  }
  if (patient !== null && anamnesis === null && totalMg > 0) {
    alerts.push({
      code: 'EPINEPHRINE_CARDIAC_UNKNOWN',
      severity: 'INFO',
      message:
        'Sin anamnesis no se sabe si es cardiópata: se usa el tope del adulto sano (0,2 mg); en el cardiópata es 0,04 mg.',
      source: EPINEPHRINE_SOURCE,
    });
  }
  return {
    summary: { totalMg, maxMg, percent, cardiac, level },
    alerts,
  };
}

/** Tolerancia de coma flotante al contar cuartos de carpule. */
const STEP_TOLERANCE = 1e-6;

/**
 * Cuartos de carpule que caben ESTRICTAMENTE por debajo de `limit` carpules:
 * llegar justo al 100 % ya exige motivo (DX-307), así que «quedan» no ofrece
 * la dosis que lo alcanza. Nunca negativo.
 */
function carpulesBelow(limit: number): number {
  if (!(limit > 0)) return 0;
  const steps = Math.ceil(limit / CARPULE_STEP - STEP_TOLERANCE) - 1;
  return Math.max(0, steps) * CARPULE_STEP;
}

/**
 * Lo que queda del anestésico nuevo hasta el máximo (la suma de fracciones
 * se reparte en sus mg) y hasta el tope de epinefrina; manda el menor. Los
 * carpules se cuentan con los valores SIN redondear (redondear antes los mg
 * podía subir un cuarto de carpule por encima del máximo).
 */
function remainingOf(
  pending: AnestheticSnapshot,
  fraction: number,
  maxMg: number,
  epinephrine: EpinephrineSummary,
): DoseRemaining {
  const rawMg = Math.max(0, 1 - fraction) * maxMg;
  const perCarpuleMg = lineMg(pending, 1);
  let rawCarpules = perCarpuleMg > 0 ? rawMg / perCarpuleMg : 0;
  let mg = round1(rawMg);
  let limitedBy: DoseRemaining['limitedBy'] = 'DOSE';
  const epinephrineMg = round4(
    Math.max(0, epinephrine.maxMg - epinephrine.totalMg),
  );
  const epiPerCarpule = epinephrinePerCarpule(pending);
  if (epiPerCarpule) {
    const byEpinephrine =
      Math.max(0, epinephrine.maxMg - epinephrine.totalMg) / epiPerCarpule;
    if (byEpinephrine < rawCarpules) {
      // Los mg que caben con la epinefrina que queda, no los del anestésico.
      rawCarpules = byEpinephrine;
      mg = round1(byEpinephrine * perCarpuleMg);
      limitedBy = 'EPINEPHRINE';
    }
  }
  return {
    name: pending.name,
    mg,
    carpules: carpulesBelow(rawCarpules),
    mlPerCarpule: pending.mlPerCarpule,
    limitedBy,
    epinephrineMg,
  };
}

export function summarizeAnesthesiaDose(
  input: DoseInput,
): AnesthesiaDoseSummary {
  const { weightKg } = input;
  const patient = input.patient ?? null;
  const pending = input.pending ?? null;
  const adjustment = doseAdjustment(patient ?? UNKNOWN_PATIENT);
  const groups = groupLines(input.lines);
  const totalMg = round1(groups.reduce((sum, g) => sum + g.mg, 0));
  const byAnesthetic: AnestheticDose[] = groups.map((g) => {
    const maxMg = maxDoseMg(g.anesthetic, weightKg, adjustment);
    return {
      name: g.anesthetic.name,
      activeIngredient: g.anesthetic.activeIngredient,
      concentrationPct: g.anesthetic.concentrationPct,
      carpules: g.carpules,
      mg: g.mg,
      maxMg,
      percent: maxMg === null ? null : percentOf(g.mg / maxMg),
      maxMgPerKg: maxMgPerKgFor(g.anesthetic, adjustment),
      maxSource: maxSourceOf(g.anesthetic, adjustment),
    };
  });

  const alerts: DoseAlert[] = [];
  let level: DoseLevel;
  let percent: number | null;
  let fraction: number | null = null;

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
    // El tope absoluto no depende del peso: también suma fracciones, y
    // también baja con las reducciones de DX-420.
    const absoluteFraction = groups.reduce(
      (sum, g) => sum + g.mg / (g.anesthetic.maxAbsoluteMg * adjustment.factor),
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
    fraction = byAnesthetic.reduce(
      (sum, a) => sum + a.mg / (a.maxMg as number),
      0,
    );
    percent = percentOf(fraction);
    const maxLabel =
      byAnesthetic.length === 1
        ? `de ${fmt(byAnesthetic[0].maxMg as number)} mg (${percent} %)`
        : `(${percent} % de la suma de los máximos de cada anestésico)`;
    const source =
      byAnesthetic.length === 1 ? byAnesthetic[0].maxSource : MALAMED;
    if (fraction + EPSILON >= DOSE_BLOCK_FRACTION) {
      level = 'EXCEEDED';
      alerts.push({
        code: 'DOSE_OVER_MAX',
        severity: 'BLOCKING',
        message: `Dosis máxima superada: ${fmt(totalMg)} mg ${maxLabel} para ${fmt(weightKg)} kg.`,
        source,
      });
    } else if (fraction + EPSILON >= DOSE_WARNING_FRACTION) {
      level = 'WARNING';
      alerts.push({
        code: 'DOSE_NEAR_MAX',
        severity: 'INFO',
        message: `Cerca de la dosis máxima: ${fmt(totalMg)} mg ${maxLabel} para ${fmt(weightKg)} kg.`,
        source,
      });
    } else {
      level = 'OK';
    }
  }

  alerts.push(...adjustmentAlerts(groups, adjustment, patient, pending));
  const epinephrine = summarizeEpinephrine(
    input.lines,
    input.anamnesis,
    patient,
  );
  alerts.push(...epinephrine.alerts);
  alerts.push(...allergyAlerts(groups, input.anamnesis));

  const pendingMax =
    pending === null ? null : maxDoseMg(pending, weightKg, adjustment);
  return {
    rulesVersion: ANESTHESIA_DOSE_RULES_VERSION,
    weightKg,
    totalMg,
    byAnesthetic,
    percent,
    level,
    alerts,
    adjustment: { ...adjustment, ageYears: patient?.ageYears ?? null },
    epinephrine: epinephrine.summary,
    remaining:
      pending === null || pendingMax === null || fraction === null
        ? null
        : remainingOf(pending, fraction, pendingMax, epinephrine.summary),
  };
}

export function hasBlockingDoseAlerts(alerts: readonly DoseAlert[]): boolean {
  return alerts.some((a) => a.severity === 'BLOCKING');
}
