import {
  findAllergyMatches,
  normalizeDrugText,
  type AllergyMatch,
} from './allergy-match';

/**
 * Receta segura (DX-300): avisos que el SERVIDOR calcula al previsualizar y
 * vuelve a calcular al emitir, cruzando cada principio activo con la
 * anamnesis vigente (lista de alergias y casillas, medicación habitual,
 * embarazo, anticoagulantes, bifosfonatos y peso) y con la edad del paciente.
 *
 * Es una AYUDA a la prescripción y no sustituye el juicio clínico: listas
 * cortas y conservadoras (avisar de más es preferible a callar), sin base
 * comercial de interacciones ni catálogo de principios activos.
 *
 * Fuentes:
 *  - SDCEP, «Drug Prescribing for Dentistry» (3.ª ed., 2016) y su apéndice de
 *    interacciones graves en odontología: AINE, metronidazol, macrólidos y
 *    azoles (incluido el miconazol tópico) con warfarina/cumarínicos; AINE con
 *    metotrexato. También el uso en embarazo (AINE evitados desde la semana
 *    20 — alerta FDA/EMA de oligohidramnios —, tetraciclinas contraindicadas,
 *    metronidazol evitado en el primer trimestre).
 *  - BNF for Children (BNFC), monografías de amoxicilina, ibuprofeno y
 *    paracetamol por vía oral (1 mes – 11 años). Topes usados (por toma y por
 *    día, en mg/kg y absolutos), en `PEDIATRIC_LIMITS`:
 *      amoxicilina  30 mg/kg/toma (máx. 1 g), 90 mg/kg/día (máx. 3 g)
 *      ibuprofeno   10 mg/kg/toma (máx. 400 mg), 30 mg/kg/día (máx. 1,2 g)
 *      paracetamol  15 mg/kg/toma (máx. 1 g), 60 mg/kg/día (máx. 4 g; 60 y
 *                   no 75 mg/kg/día: el tope de la ficha técnica española)
 *
 * Versionado: `PRESCRIPTION_SAFETY_RULES_VERSION` va en cada receta emitida
 * (dentro del hash). Cambiar una regla, un tope o un texto obliga a subir la
 * versión, para saber con qué reglas se emitió cada receta.
 */
export const PRESCRIPTION_SAFETY_RULES_VERSION = 'RX_SAFETY_V1';

export type SafetyRule =
  | 'ALLERGY'
  | 'INTERACTION'
  | 'PREGNANCY'
  | 'ANTIRESORPTIVE'
  | 'PEDIATRIC_DOSE'
  | 'NO_ANAMNESIS';

/** BLOCKING exige confirmación y motivo para emitir; INFO solo se muestra. */
export type SafetySeverity = 'BLOCKING' | 'INFO';

export interface SafetyAlert {
  rule: SafetyRule;
  /** Referencia estable de la regla concreta, p. ej. `PREGNANCY_NSAID`. */
  code: string;
  severity: SafetySeverity;
  /** El principio activo de la receta que lo dispara; null si es general. */
  activeIngredient: string | null;
  message: string;
  /** De dónde sale la regla (fuente clínica). */
  source: string;
}

/** Lo que la anamnesis VIGENTE aporta a la comprobación. */
export interface SafetyAnamnesis {
  /** `alergeno` de cada alergia de la lista. */
  allergens: string[];
  /** `nombre` de cada medicamento habitual. */
  medications: string[];
  flags: {
    alergiaPenicilina: boolean;
    alergiaAnestesico: boolean;
    alergiaLatex: boolean;
    embarazo: boolean;
    semanasEmbarazo: number | null;
    anticoagulantes: boolean;
    bifosfonatos: boolean;
  };
  /** `vitalSigns.peso`, si es un peso plausible. */
  weightKg: number | null;
}

export interface SafetyItem {
  activeIngredient: string;
  concentration?: string | null;
  dose?: string | null;
  frequency?: string | null;
}

export interface SafetyCheckInput {
  items: readonly SafetyItem[];
  /** null = el paciente no tiene anamnesis. */
  anamnesis: SafetyAnamnesis | null;
  /** Años cumplidos el día de la receta; null sin fecha de nacimiento. */
  ageYears: number | null;
}

export interface SafetyCheckResult {
  rulesVersion: string;
  alerts: SafetyAlert[];
  /** Las coincidencias de alergia (se siguen guardando como en DX-013). */
  allergyMatches: AllergyMatch[];
}

export const NO_ANAMNESIS_MESSAGE =
  'Sin anamnesis vigente: no se han podido comprobar alergias ni interacciones';
export const PEDIATRIC_WEIGHT_MISSING_MESSAGE =
  'Registra el peso para comprobar la dosis';

/** Por debajo de esta edad (años cumplidos) se comprueba la dosis por peso. */
export const PEDIATRIC_AGE_LIMIT = 12;

const SDCEP = 'SDCEP, Drug Prescribing for Dentistry (interacciones graves)';
const SDCEP_PREGNANCY = 'SDCEP, Drug Prescribing for Dentistry (embarazo)';
const SDCEP_BRONJ =
  'SDCEP, Oral Health Management of Patients at Risk of MRONJ';
const BNFC = 'BNF for Children (dosis oral por peso)';
const DX013 = 'Anamnesis: alergias registradas';

/** Casillas de alergia → alérgeno que entiende `findAllergyMatches`. */
const FLAG_ALLERGENS = [
  ['alergiaPenicilina', 'penicilina'],
  ['alergiaAnestesico', 'anestésico local'],
  ['alergiaLatex', 'látex'],
] as const;

/** Patrones sobre UNA palabra normalizada (sin tildes ni mayúsculas). */
type Patterns = readonly RegExp[];

const NSAID: Patterns = [
  /^aines?$/,
  /profen/,
  /^naproxen/,
  /fenac/,
  /xicam/,
  /^ketorolac/,
  /^nimesulid/,
  /^aspirin/,
  /acetilsalicil/,
  /coxib/,
];
const METRONIDAZOLE: Patterns = [/nidazol/];
const MACROLIDE: Patterns = [/^macrolid/, /tromicin/, /thromycin/];
const AZOLE: Patterns = [/conazol/];
const TETRACYCLINE: Patterns = [/ciclin/, /cyclin/];
const ANTICOAGULANT: Patterns = [
  /^anticoagul/,
  /^warfarin/,
  /^acenocumarol/,
  /^sintrom/,
  /^aldocumar/,
  /^fenprocumon/,
  /^apixaban/,
  /^rivaroxaban/,
  /^dabigatran/,
  /^edoxaban/,
];
const METHOTREXATE: Patterns = [/^metotrexat/, /^methotrexat/];

function matches(text: string, patterns: Patterns): boolean {
  return normalizeDrugText(text)
    .split(' ')
    .some((word) => patterns.some((p) => p.test(word)));
}

/* ── Dosis infantil ─────────────────────────────────────────────────────── */

interface PediatricLimit {
  label: string;
  patterns: Patterns;
  perDoseMgKg: number;
  perDoseMaxMg: number;
  perDayMgKg: number;
  perDayMaxMg: number;
}

export const PEDIATRIC_LIMITS: readonly PediatricLimit[] = [
  {
    label: 'amoxicilina',
    patterns: [/^amoxicil/],
    perDoseMgKg: 30,
    perDoseMaxMg: 1000,
    perDayMgKg: 90,
    perDayMaxMg: 3000,
  },
  {
    label: 'ibuprofeno',
    patterns: [/^ibuprofen/],
    perDoseMgKg: 10,
    perDoseMaxMg: 400,
    perDayMgKg: 30,
    perDayMaxMg: 1200,
  },
  {
    label: 'paracetamol',
    patterns: [/^paracetamol/, /^acetaminofen/],
    perDoseMgKg: 15,
    perDoseMaxMg: 1000,
    perDayMgKg: 60,
    perDayMaxMg: 4000,
  },
];

/** Minúsculas y sin tildes, conservando cifras, comas, puntos y «/». */
function plain(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const NUMBER = String.raw`(\d+(?:[.,]\d+)?)`;
const toNumber = (raw: string) => Number(raw.replace(',', '.'));

/** «500 mg», «1 g», «1,5 g» → mg. No casa «250 mg/5 ml». */
function massMg(text: string): number | null {
  const m = new RegExp(
    String.raw`${NUMBER}\s*(mg|g|gr|gramos?|miligramos?)\b(?!\s*\/)`,
  ).exec(text);
  if (!m) return null;
  return toNumber(m[1]) * (m[2].startsWith('m') ? 1 : 1000);
}

/** «250 mg/5 ml» → 50 mg/ml; «100 mg/ml» → 100. */
function mgPerMl(text: string): number | null {
  const m = new RegExp(
    String.raw`${NUMBER}\s*(mg|g)\s*\/\s*(?:${NUMBER}\s*)?ml\b`,
  ).exec(text);
  if (!m) return null;
  const mg = toNumber(m[1]) * (m[2] === 'g' ? 1000 : 1);
  return mg / (m[3] ? toNumber(m[3]) : 1);
}

/** Unidades por toma («1 cápsula», «medio comprimido», «2»). */
function unitCount(dose: string): number | null {
  if (/^(medio|media)\b/.test(dose)) return 0.5;
  if (/^(un|una|uno)\b/.test(dose)) return 1;
  const n = new RegExp(String.raw`^${NUMBER}`).exec(dose);
  return n ? toNumber(n[1]) : null;
}

/** mg por toma, o null si dosis y concentración no lo dejan calcular. */
export function doseMg(item: SafetyItem): number | null {
  const dose = plain(item.dose);
  const concentration = plain(item.concentration);
  const direct = massMg(dose);
  if (direct !== null) return direct;
  const ml = new RegExp(String.raw`${NUMBER}\s*ml\b`).exec(dose);
  if (ml) {
    const perMl = mgPerMl(concentration);
    return perMl === null ? null : toNumber(ml[1]) * perMl;
  }
  const units = unitCount(dose);
  const perUnit = massMg(concentration);
  return units === null || perUnit === null ? null : units * perUnit;
}

/** Tomas al día a partir de «Cada 8 horas», «3 veces al día»… */
export function dosesPerDay(
  frequency: string | null | undefined,
): number | null {
  const text = plain(frequency);
  const every = new RegExp(
    String.raw`cada\s+${NUMBER}\s*(h|hs|hr|horas?)\b`,
  ).exec(text);
  if (every) {
    const hours = toNumber(every[1]);
    return hours > 0 ? Math.ceil(24 / hours) : null;
  }
  const times = new RegExp(
    String.raw`${NUMBER}\s*(veces|tomas?)\s*(al|por|cada)\s*dia`,
  ).exec(text);
  if (times) return toNumber(times[1]);
  if (/\b(una vez|1 vez)\s*(al|por)\s*dia\b|cada 24/.test(text)) return 1;
  return null;
}

const round = (n: number) => Math.round(n * 10) / 10;
const fmt = (n: number) => String(round(n)).replace('.', ',');

function pediatricAlert(
  item: SafetyItem,
  limit: PediatricLimit,
  weightKg: number | null,
): SafetyAlert | null {
  const base = {
    rule: 'PEDIATRIC_DOSE' as const,
    activeIngredient: item.activeIngredient,
    source: BNFC,
  };
  if (weightKg === null) {
    return {
      ...base,
      code: 'PEDIATRIC_WEIGHT_MISSING',
      severity: 'INFO',
      message: `${PEDIATRIC_WEIGHT_MISSING_MESSAGE}: ${item.activeIngredient} en menores de ${PEDIATRIC_AGE_LIMIT} años se dosifica por peso (máx. ${limit.perDoseMgKg} mg/kg/toma).`,
    };
  }
  const perDose = doseMg(item);
  if (perDose === null) {
    return {
      ...base,
      code: 'PEDIATRIC_DOSE_UNREADABLE',
      severity: 'INFO',
      message: `No se pudo calcular la dosis de ${item.activeIngredient} en mg: escribe la dosis en mg (o en ml con la concentración en mg/ml) para comprobarla con el peso (${fmt(weightKg)} kg).`,
    };
  }
  const problems: string[] = [];
  const perDoseKg = perDose / weightKg;
  if (perDoseKg > limit.perDoseMgKg + 1e-9) {
    problems.push(
      `${fmt(perDose)} mg por toma son ${fmt(perDoseKg)} mg/kg/toma y supera el tope de ${limit.perDoseMgKg} mg/kg/toma`,
    );
  } else if (perDose > limit.perDoseMaxMg) {
    problems.push(
      `${fmt(perDose)} mg por toma supera el tope de ${limit.perDoseMaxMg} mg por toma`,
    );
  }
  const perDay = dosesPerDay(item.frequency);
  if (perDay !== null) {
    const daily = perDose * perDay;
    const dailyKg = daily / weightKg;
    if (dailyKg > limit.perDayMgKg + 1e-9) {
      problems.push(
        `${perDay} tomas al día son ${fmt(dailyKg)} mg/kg/día y supera el tope de ${limit.perDayMgKg} mg/kg/día`,
      );
    } else if (daily > limit.perDayMaxMg) {
      problems.push(
        `${fmt(daily)} mg al día supera el tope de ${limit.perDayMaxMg} mg al día`,
      );
    }
  }
  if (problems.length === 0) return null;
  return {
    ...base,
    code: 'PEDIATRIC_DOSE_EXCEEDED',
    severity: 'BLOCKING',
    message: `Dosis infantil de ${item.activeIngredient} para ${fmt(weightKg)} kg: ${problems.join('; ')}.`,
  };
}

/* ── Comprobación ──────────────────────────────────────────────────────── */

/** Años cumplidos el día civil `onDay` (YYYY-MM-DD). */
export function ageInYears(birthDate: Date, onDay: string): number {
  const [y, m, d] = onDay.split('-').map(Number);
  const by = birthDate.getUTCFullYear();
  const bm = birthDate.getUTCMonth() + 1;
  const bd = birthDate.getUTCDate();
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

export function emptySafetyAnamnesis(): SafetyAnamnesis {
  return {
    allergens: [],
    medications: [],
    flags: {
      alergiaPenicilina: false,
      alergiaAnestesico: false,
      alergiaLatex: false,
      embarazo: false,
      semanasEmbarazo: null,
      anticoagulantes: false,
      bifosfonatos: false,
    },
    weightKg: null,
  };
}

export function hasBlockingAlerts(alerts: readonly SafetyAlert[]): boolean {
  return alerts.some((a) => a.severity === 'BLOCKING');
}

function interactionAlerts(
  ingredient: string,
  anamnesis: SafetyAnamnesis,
): SafetyAlert[] {
  const out: SafetyAlert[] = [];
  const anticoagulant =
    anamnesis.medications.find((m) => matches(m, ANTICOAGULANT)) ??
    (anamnesis.flags.anticoagulantes
      ? 'anticoagulante/antiagregante marcado en la anamnesis'
      : null);
  if (anticoagulant) {
    const pairs: [Patterns, string, string][] = [
      [NSAID, 'NSAID', 'un AINE: aumenta el riesgo de sangrado'],
      [
        METRONIDAZOLE,
        'METRONIDAZOLE',
        'metronidazol: potencia el anticoagulante (INR) y el riesgo de sangrado',
      ],
      [
        MACROLIDE,
        'MACROLIDE',
        'un macrólido: potencia el anticoagulante (INR) y el riesgo de sangrado',
      ],
      [
        AZOLE,
        'AZOLE',
        'un azol (también el miconazol oral tópico): potencia el anticoagulante (INR) y el riesgo de sangrado',
      ],
    ];
    for (const [patterns, code, what] of pairs) {
      if (!matches(ingredient, patterns)) continue;
      out.push({
        rule: 'INTERACTION',
        code: `INTERACTION_ANTICOAGULANT_${code}`,
        severity: 'BLOCKING',
        activeIngredient: ingredient,
        message: `Interacción grave: el paciente toma ${anticoagulant} y ${ingredient} es ${what}.`,
        source: SDCEP,
      });
    }
  }
  const methotrexate = anamnesis.medications.find((m) =>
    matches(m, METHOTREXATE),
  );
  if (methotrexate && matches(ingredient, NSAID)) {
    out.push({
      rule: 'INTERACTION',
      code: 'INTERACTION_METHOTREXATE_NSAID',
      severity: 'BLOCKING',
      activeIngredient: ingredient,
      message: `Interacción grave: el paciente toma ${methotrexate} y ${ingredient} es un AINE: reduce la eliminación del metotrexato (toxicidad).`,
      source: SDCEP,
    });
  }
  return out;
}

function pregnancyAlerts(
  ingredient: string,
  flags: SafetyAnamnesis['flags'],
): SafetyAlert[] {
  if (!flags.embarazo) return [];
  const weeks = flags.semanasEmbarazo;
  const weeksText =
    weeks === null ? 'semanas sin registrar' : `${weeks} semanas`;
  const base = {
    rule: 'PREGNANCY' as const,
    activeIngredient: ingredient,
    source: SDCEP_PREGNANCY,
  };
  const out: SafetyAlert[] = [];
  if (matches(ingredient, NSAID)) {
    out.push(
      weeks === null || weeks >= 20
        ? {
            ...base,
            code: 'PREGNANCY_NSAID',
            severity: 'BLOCKING',
            message: `Embarazo (${weeksText}): evita ${ingredient} (AINE) desde la semana 20 por riesgo de oligohidramnios y cierre del ductus; el paracetamol es la alternativa habitual.`,
          }
        : {
            ...base,
            code: 'PREGNANCY_NSAID_EARLY',
            severity: 'INFO',
            message: `Embarazo (${weeksText}): ${ingredient} es un AINE; si es imprescindible, la menor dosis el menor tiempo y nunca desde la semana 20.`,
          },
    );
  }
  if (matches(ingredient, TETRACYCLINE)) {
    out.push({
      ...base,
      code: 'PREGNANCY_TETRACYCLINE',
      severity: 'BLOCKING',
      message: `Embarazo (${weeksText}): las tetraciclinas (${ingredient}) están contraindicadas (tinción dental y efecto sobre el hueso fetal).`,
    });
  }
  if (matches(ingredient, METRONIDAZOLE) && (weeks === null || weeks < 14)) {
    out.push({
      ...base,
      code: 'PREGNANCY_METRONIDAZOLE_FIRST_TRIMESTER',
      severity: 'BLOCKING',
      message: `Embarazo (${weeksText}): evita ${ingredient} en el primer trimestre.`,
    });
  }
  return out;
}

/**
 * Todos los avisos de una receta, en orden estable: por medicamento (alergia,
 * interacción, embarazo, dosis) y los generales (sin anamnesis, antirresortivos)
 * delante.
 */
export function checkPrescriptionSafety(
  input: SafetyCheckInput,
): SafetyCheckResult {
  const items = input.items
    .map((item) => ({
      ...item,
      activeIngredient: item.activeIngredient.trim(),
    }))
    .filter((item) => item.activeIngredient !== '');
  const anamnesis = input.anamnesis;
  const alerts: SafetyAlert[] = [];

  if (!anamnesis) {
    alerts.push({
      rule: 'NO_ANAMNESIS',
      code: 'NO_ANAMNESIS',
      severity: 'INFO',
      activeIngredient: null,
      message: NO_ANAMNESIS_MESSAGE,
      source: DX013,
    });
  } else if (anamnesis.flags.bifosfonatos && items.length > 0) {
    alerts.push({
      rule: 'ANTIRESORPTIVE',
      code: 'ANTIRESORPTIVE_MRONJ',
      severity: 'INFO',
      activeIngredient: null,
      message:
        'El paciente toma antirresortivos (bifosfonatos o denosumab): riesgo de osteonecrosis de los maxilares en procedimientos invasivos. Tenlo en cuenta en el plan.',
      source: SDCEP_BRONJ,
    });
  }

  const allergens = anamnesis
    ? [
        ...anamnesis.allergens,
        ...FLAG_ALLERGENS.filter(([flag]) => anamnesis.flags[flag]).map(
          ([, allergen]) => allergen,
        ),
      ]
    : [];
  const allergyMatches: AllergyMatch[] = [];

  for (const item of items) {
    const ingredient = item.activeIngredient;
    // Una alergia por medicamento: la lista manda; la casilla solo si la
    // lista no la recoge ya (sin aviso duplicado).
    const itemMatches = findAllergyMatches([ingredient], allergens);
    if (itemMatches.length > 0) {
      allergyMatches.push(...itemMatches);
      alerts.push({
        rule: 'ALLERGY',
        code: 'ALLERGY_MATCH',
        severity: 'BLOCKING',
        activeIngredient: ingredient,
        message: `Alergia: el paciente tiene registrada alergia a ${itemMatches.map((m) => m.allergen).join(', ')} y ${ingredient} puede causarla.`,
        source: DX013,
      });
    }
    if (anamnesis) {
      alerts.push(...interactionAlerts(ingredient, anamnesis));
      alerts.push(...pregnancyAlerts(ingredient, anamnesis.flags));
    }
    if (input.ageYears !== null && input.ageYears < PEDIATRIC_AGE_LIMIT) {
      const limit = PEDIATRIC_LIMITS.find((l) =>
        matches(ingredient, l.patterns),
      );
      const alert = limit
        ? pediatricAlert(item, limit, anamnesis?.weightKg ?? null)
        : null;
      if (alert) alerts.push(alert);
    }
  }

  return {
    rulesVersion: PRESCRIPTION_SAFETY_RULES_VERSION,
    alerts,
    allergyMatches,
  };
}
