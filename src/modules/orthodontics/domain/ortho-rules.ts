import type {
  OrthoCaseStatus,
  OrthoElasticType,
  OrthoElasticWear,
  OrthoIncident,
  OrthoTechnique,
  OrthoWireMaterial,
} from '@prisma/client';
import {
  addCivilDays,
  civilDaysInclusive,
  parseCivilDate,
} from '../../../shared/time/civil-day';

/**
 * DX-190: reglas del caso de ortodoncia y de su control, sin E/S. Los mismos
 * topes viven como CHECK en la BD (20261229190200_dx190_orthodontics); aquí
 * salen como 400 en español, todos los fallos en un mensaje.
 */

export const ORTHO_MONTHS_MIN = 1;
export const ORTHO_MONTHS_MAX = 120;
export const ORTHO_VISITS_MIN = 1;
export const ORTHO_VISITS_MAX = 240;
export const ORTHO_INTERVAL_MIN = 7;
export const ORTHO_INTERVAL_MAX = 180;
export const ORTHO_DEFAULT_INTERVAL_DAYS = 30;
/** Días de gracia sobre el intervalo antes de marcar «Atrasado». */
export const ORTHO_OVERDUE_GRACE_DAYS = 15;
export const ORTHO_REASON_MIN = 3;
export const ORTHO_REASON_MAX = 500;
export const ORTHO_APPLIANCE_MAX = 500;
export const ORTHO_NOTE_MAX = 2000;
export const ORTHO_GAUGE_MAX = 20;
export const ORTHO_GAUGES_MAX = 40;
/** Hasta cuándo se puede proponer el próximo control (días tras el control). */
export const ORTHO_NEXT_VISIT_MAX_DAYS = 365;

export const ORTHO_TECHNIQUE_LABELS: Record<OrthoTechnique, string> = {
  METAL_BRACKETS: 'Brackets metálicos',
  AESTHETIC_BRACKETS: 'Brackets estéticos',
  SELF_LIGATING: 'Autoligado',
  ALIGNERS: 'Alineadores',
  REMOVABLE: 'Removible',
  OTHER: 'Otra',
};

export const ORTHO_WIRE_MATERIAL_LABELS: Record<OrthoWireMaterial, string> = {
  NITI: 'NiTi',
  STEEL: 'Acero',
  TMA: 'TMA',
  OTHER: 'Otro',
};

export const ORTHO_ELASTIC_TYPE_LABELS: Record<OrthoElasticType, string> = {
  CLASS_II: 'Clase II',
  CLASS_III: 'Clase III',
  CROSS: 'Cruzados',
  BOX: 'En caja',
  TRIANGLE: 'Triangulares',
  OTHER: 'Otros',
};

export const ORTHO_ELASTIC_WEAR_LABELS: Record<OrthoElasticWear, string> = {
  FULL_TIME: 'todo el día',
  NIGHT: 'solo de noche',
  PART_TIME: 'parte del día',
};

export const ORTHO_INCIDENT_LABELS: Record<OrthoIncident, string> = {
  BRACKET_DEBONDED: 'Bracket despegado',
  BRACKET_BROKEN: 'Bracket roto',
  WIRE_DAMAGED: 'Arco dañado',
};

export const ORTHO_HYGIENE_LABELS: Record<number, string> = {
  1: 'buena',
  2: 'aceptable',
  3: 'deficiente',
  4: 'mala',
};

/** Calibres de fábrica (pulgadas, como los venden los fabricantes). */
export const ORTHO_DEFAULT_WIRE_GAUGES = [
  '0.012',
  '0.014',
  '0.016',
  '0.018',
  '0.020',
  '0.016x0.016',
  '0.016x0.022',
  '0.017x0.025',
  '0.018x0.025',
  '0.019x0.025',
] as const;

export const ORTHO_MESSAGES = {
  activeExists:
    'Este paciente ya tiene un caso de ortodoncia activo. Ciérralo o pásalo a retención antes de abrir otro.',
  caseNotFound: 'Caso de ortodoncia no encontrado en esta clínica',
  caseClosed:
    'El caso de ortodoncia está cerrado (finalizado o abandonado): ya no se modifica.',
  caseNotOpenForVisits:
    'Solo se registran controles en un caso activo o en retención.',
  moduleDisabled:
    'La ortodoncia no está activada en esta clínica. Actívala en Ajustes › Ortodoncia.',
  providerNotFound: 'Profesional no encontrado en esta clínica',
  planNotFound:
    'El plan de tratamiento no existe en esta clínica o es de otro paciente',
  locationNotFound: 'Sede no encontrada en esta clínica',
  transition: (from: OrthoCaseStatus, to: OrthoCaseStatus) =>
    `Un caso ${STATUS_LABELS[from]} no puede pasar a ${STATUS_LABELS[to]}.`,
  emptyVisit:
    'El control está vacío: indica al menos un arco, los elásticos, la aparatología, una incidencia, la higiene o una nota.',
  settingsGauges: `Indica entre 1 y ${ORTHO_GAUGES_MAX} calibres distintos, cada uno de 1 a ${ORTHO_GAUGE_MAX} caracteres en una línea.`,
  settingsEnabled: 'Indica si la clínica usa la ortodoncia (sí o no).',
} as const;

const STATUS_LABELS: Record<OrthoCaseStatus, string> = {
  ACTIVE: 'activo',
  RETENTION: 'en retención',
  FINISHED: 'finalizado',
  ABANDONED: 'abandonado',
};

/** Transiciones permitidas. FINISHED y ABANDONED cierran el caso. */
const TRANSITIONS: Record<OrthoCaseStatus, readonly OrthoCaseStatus[]> = {
  ACTIVE: ['RETENTION', 'FINISHED', 'ABANDONED'],
  RETENTION: ['FINISHED', 'ABANDONED'],
  FINISHED: [],
  ABANDONED: [],
};

export function isClosedStatus(status: OrthoCaseStatus): boolean {
  return status === 'FINISHED' || status === 'ABANDONED';
}

export function canTransition(
  from: OrthoCaseStatus,
  to: OrthoCaseStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function acceptsVisits(status: OrthoCaseStatus): boolean {
  return status === 'ACTIVE' || status === 'RETENTION';
}

type Result<T> = { ok: true; value: T } | { ok: false; message: string };

const NOT_ONE_LINE = /[\p{Cc}\u2028\u2029]/u;

function isWhole(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** Texto recortado; `null` si vacío o ausente. */
function trimmed(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const t = value.trim();
  return t === '' ? null : t;
}

// ---------------------------------------------------------------------------
// Caso
// ---------------------------------------------------------------------------

export interface OrthoCasePlanInput {
  technique?: OrthoTechnique;
  startDate?: string;
  estimatedMonths?: number;
  plannedVisits?: number;
  visitIntervalDays?: number;
  bondedOn?: string | null;
  debondedOn?: string | null;
}

export interface OrthoCasePlan {
  technique: OrthoTechnique;
  startDate: string;
  estimatedMonths: number;
  plannedVisits: number;
  visitIntervalDays: number;
  bondedOn: string | null;
  debondedOn: string | null;
}

function optionalDay(
  value: string | null | undefined,
  label: string,
  errors: string[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const day = parseCivilDate(value);
  if (!day) errors.push(`${label} debe ser una fecha AAAA-MM-DD`);
  return day;
}

/**
 * Valida la planificación de un caso. Con `current` (edición) los campos
 * ausentes conservan su valor; sin él (alta) los obligatorios tienen que venir.
 * `today` es el día civil de la sede: el inicio y las fechas de cementado y
 * retiro no pueden ser futuras.
 */
export function validateCasePlan(
  input: OrthoCasePlanInput,
  today: string,
  current?: OrthoCasePlan,
): Result<OrthoCasePlan> {
  const errors: string[] = [];
  const technique = input.technique ?? current?.technique;
  if (!technique) errors.push('Indica la técnica');

  let startDate = current?.startDate;
  if (input.startDate !== undefined || !current) {
    const parsed = input.startDate ? parseCivilDate(input.startDate) : null;
    if (!parsed)
      errors.push('La fecha de inicio debe ser una fecha AAAA-MM-DD');
    else if (parsed > today)
      errors.push('La fecha de inicio no puede ser futura');
    startDate = parsed ?? undefined;
  }

  const months = input.estimatedMonths ?? current?.estimatedMonths;
  if (!isWhole(months, ORTHO_MONTHS_MIN, ORTHO_MONTHS_MAX)) {
    errors.push(
      `La duración estimada va de ${ORTHO_MONTHS_MIN} a ${ORTHO_MONTHS_MAX} meses`,
    );
  }
  const visits = input.plannedVisits ?? current?.plannedVisits;
  if (!isWhole(visits, ORTHO_VISITS_MIN, ORTHO_VISITS_MAX)) {
    errors.push(
      `Los controles previstos van de ${ORTHO_VISITS_MIN} a ${ORTHO_VISITS_MAX}`,
    );
  }
  const interval =
    input.visitIntervalDays ??
    current?.visitIntervalDays ??
    ORTHO_DEFAULT_INTERVAL_DAYS;
  if (!isWhole(interval, ORTHO_INTERVAL_MIN, ORTHO_INTERVAL_MAX)) {
    errors.push(
      `El intervalo entre controles va de ${ORTHO_INTERVAL_MIN} a ${ORTHO_INTERVAL_MAX} días`,
    );
  }

  const bonded = optionalDay(input.bondedOn, 'El cementado', errors);
  const debonded = optionalDay(input.debondedOn, 'El retiro', errors);
  const bondedOn = bonded === undefined ? (current?.bondedOn ?? null) : bonded;
  const debondedOn =
    debonded === undefined ? (current?.debondedOn ?? null) : debonded;
  if (bondedOn && bondedOn > today) {
    errors.push('La fecha de cementado no puede ser futura');
  }
  if (debondedOn && debondedOn > today) {
    errors.push('La fecha de retiro no puede ser futura');
  }
  if (bondedOn && debondedOn && debondedOn < bondedOn) {
    errors.push('El retiro no puede ser anterior al cementado');
  }

  if (errors.length > 0) return { ok: false, message: `${errors.join('. ')}.` };
  return {
    ok: true,
    value: {
      technique: technique as OrthoTechnique,
      startDate: startDate as string,
      estimatedMonths: months as number,
      plannedVisits: visits as number,
      visitIntervalDays: interval,
      bondedOn,
      debondedOn,
    },
  };
}

/** Motivo del cambio de estado: obligatorio al abandonar. */
export function validateStatusChange(
  from: OrthoCaseStatus,
  to: OrthoCaseStatus,
  reason: string | null | undefined,
): Result<{ reason: string | null }> {
  if (!canTransition(from, to)) {
    return { ok: false, message: ORTHO_MESSAGES.transition(from, to) };
  }
  const text = trimmed(reason);
  if (to === 'ABANDONED' && !text) {
    return {
      ok: false,
      message: 'Indica el motivo del abandono del caso.',
    };
  }
  if (
    text &&
    ([...text].length < ORTHO_REASON_MIN || [...text].length > ORTHO_REASON_MAX)
  ) {
    return {
      ok: false,
      message: `El motivo admite de ${ORTHO_REASON_MIN} a ${ORTHO_REASON_MAX} caracteres.`,
    };
  }
  return { ok: true, value: { reason: text } };
}

// ---------------------------------------------------------------------------
// Ajustes de la clínica
// ---------------------------------------------------------------------------

/** Calibres recortados, sin repetir (en el orden dado), o el error. */
export function validateWireGauges(input: unknown): Result<string[]> {
  if (!Array.isArray(input)) {
    return { ok: false, message: ORTHO_MESSAGES.settingsGauges };
  }
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') {
      return { ok: false, message: ORTHO_MESSAGES.settingsGauges };
    }
    const gauge = raw.trim();
    if (
      gauge === '' ||
      [...gauge].length > ORTHO_GAUGE_MAX ||
      NOT_ONE_LINE.test(gauge)
    ) {
      return { ok: false, message: ORTHO_MESSAGES.settingsGauges };
    }
    if (out.includes(gauge)) {
      return { ok: false, message: ORTHO_MESSAGES.settingsGauges };
    }
    out.push(gauge);
  }
  if (out.length < 1 || out.length > ORTHO_GAUGES_MAX) {
    return { ok: false, message: ORTHO_MESSAGES.settingsGauges };
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

export interface OrthoWire {
  material: OrthoWireMaterial;
  gauge: string;
}

export interface OrthoVisitInput {
  upperWire?: { material?: OrthoWireMaterial; gauge?: string } | null;
  lowerWire?: { material?: OrthoWireMaterial; gauge?: string } | null;
  elasticsType?: OrthoElasticType | null;
  elasticsWear?: OrthoElasticWear | null;
  applianceChanges?: string | null;
  incidents?: OrthoIncident[];
  hygieneIndex?: number | null;
  note?: string | null;
  nextVisitProposedOn?: string | null;
}

export interface OrthoVisitData {
  upperWire: OrthoWire | null;
  lowerWire: OrthoWire | null;
  elasticsType: OrthoElasticType | null;
  elasticsWear: OrthoElasticWear | null;
  applianceChanges: string | null;
  incidents: OrthoIncident[];
  hygieneIndex: number | null;
  note: string | null;
  /** `YYYY-MM-DD`, o null. */
  nextVisitProposedOn: string | null;
}

function wire(
  value: OrthoVisitInput['upperWire'],
  label: string,
  gauges: readonly string[],
  errors: string[],
): OrthoWire | null {
  if (!value) return null;
  const gauge = trimmed(value.gauge);
  if (!value.material && !gauge) return null;
  if (!value.material || !gauge) {
    errors.push(`El arco ${label} necesita material y calibre`);
    return null;
  }
  if (!gauges.includes(gauge)) {
    errors.push(
      `El calibre «${gauge}» del arco ${label} no está en la lista de la clínica`,
    );
    return null;
  }
  return { material: value.material, gauge };
}

/**
 * Valida un control. `gauges` es la lista de la clínica; el próximo control
 * propuesto se compara con el día del control, que decide la evolución (día
 * de la cita o el indicado), así que se valida aparte con
 * `validateNextVisit`.
 */
export function validateVisit(
  input: OrthoVisitInput,
  gauges: readonly string[],
): Result<OrthoVisitData> {
  const errors: string[] = [];
  const upperWire = wire(input.upperWire, 'superior', gauges, errors);
  const lowerWire = wire(input.lowerWire, 'inferior', gauges, errors);
  const elasticsType = input.elasticsType ?? null;
  const elasticsWear = input.elasticsWear ?? null;
  if (elasticsWear && !elasticsType) {
    errors.push('Indica el tipo de elásticos además de su uso');
  }
  const applianceChanges = trimmed(input.applianceChanges);
  if (applianceChanges && [...applianceChanges].length > ORTHO_APPLIANCE_MAX) {
    errors.push(
      `La aparatología admite hasta ${ORTHO_APPLIANCE_MAX} caracteres`,
    );
  }
  const incidents = [...new Set(input.incidents ?? [])];
  const hygieneIndex = input.hygieneIndex ?? null;
  if (hygieneIndex !== null && !isWhole(hygieneIndex, 1, 4)) {
    errors.push('El índice de higiene va de 1 a 4');
  }
  const note = trimmed(input.note);
  if (note && [...note].length > ORTHO_NOTE_MAX) {
    errors.push(`La nota admite hasta ${ORTHO_NOTE_MAX} caracteres`);
  }
  let nextVisitProposedOn: string | null = null;
  if (input.nextVisitProposedOn) {
    nextVisitProposedOn = parseCivilDate(input.nextVisitProposedOn);
    if (!nextVisitProposedOn) {
      errors.push('El próximo control debe ser una fecha AAAA-MM-DD');
    }
  }
  if (errors.length > 0) return { ok: false, message: `${errors.join('. ')}.` };
  const data: OrthoVisitData = {
    upperWire,
    lowerWire,
    elasticsType,
    elasticsWear,
    applianceChanges,
    incidents,
    hygieneIndex,
    note,
    nextVisitProposedOn,
  };
  if (
    !upperWire &&
    !lowerWire &&
    !elasticsType &&
    !applianceChanges &&
    incidents.length === 0 &&
    hygieneIndex === null &&
    !note
  ) {
    return { ok: false, message: ORTHO_MESSAGES.emptyVisit };
  }
  return { ok: true, value: data };
}

/** El próximo control propuesto: posterior al control y como mucho a un año. */
export function validateNextVisit(
  next: string | null,
  visitDate: string,
): string | null {
  if (!next) return null;
  if (next <= visitDate) {
    return 'El próximo control propuesto tiene que ser posterior al control.';
  }
  if (next > addCivilDays(visitDate, ORTHO_NEXT_VISIT_MAX_DAYS)) {
    return 'El próximo control propuesto no puede ir más allá de un año.';
  }
  return null;
}

/**
 * Texto de la evolución que documenta el control (la historia clínica general
 * lo muestra como cualquier otra evolución). Solo lo registrado.
 */
export function composeVisitNote(data: OrthoVisitData): string {
  const lines = ['Control de ortodoncia.'];
  const wireText = (w: OrthoWire) =>
    `${ORTHO_WIRE_MATERIAL_LABELS[w.material]} ${w.gauge}`;
  if (data.upperWire) lines.push(`Arco superior: ${wireText(data.upperWire)}.`);
  if (data.lowerWire) lines.push(`Arco inferior: ${wireText(data.lowerWire)}.`);
  if (data.elasticsType) {
    const wear = data.elasticsWear
      ? ` (${ORTHO_ELASTIC_WEAR_LABELS[data.elasticsWear]})`
      : '';
    lines.push(
      `Elásticos: ${ORTHO_ELASTIC_TYPE_LABELS[data.elasticsType]}${wear}.`,
    );
  }
  if (data.applianceChanges) {
    lines.push(`Aparatología: ${data.applianceChanges}`);
  }
  if (data.incidents.length > 0) {
    lines.push(
      `Incidencias: ${data.incidents.map((i) => ORTHO_INCIDENT_LABELS[i]).join(', ')}.`,
    );
  }
  if (data.hygieneIndex !== null) {
    lines.push(
      `Higiene: ${data.hygieneIndex}/4 (${ORTHO_HYGIENE_LABELS[data.hygieneIndex]}).`,
    );
  }
  if (data.nextVisitProposedOn) {
    lines.push(`Próximo control propuesto: ${data.nextVisitProposedOn}.`);
  }
  if (data.note) lines.push('', data.note);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Progreso y seguimiento
// ---------------------------------------------------------------------------

/** Meses completos de `from` a `to` (días civiles). Nunca negativo. */
export function wholeMonthsBetween(from: string, to: string): number {
  if (to <= from) return 0;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return Math.max(0, months);
}

/**
 * Porcentaje entero hacia abajo (3 de 24 → 12), con tope 100. Aritmética
 * entera: no es un importe y no pasa por los redondeos de dinero.
 */
export function wholePercent(part: number, whole: number): number {
  if (whole <= 0 || part >= whole) return whole <= 0 ? 0 : 100;
  const scaled = part * 100;
  return (scaled - (scaled % whole)) / whole;
}

export interface OrthoProgress {
  visitsDone: number;
  plannedVisits: number;
  monthsElapsed: number;
  estimatedMonths: number;
  /** 0–100 (entero hacia abajo), controles realizados sobre previstos (tope 100). */
  percent: number;
}

export function caseProgress(
  c: { startDate: string; plannedVisits: number; estimatedMonths: number },
  visitsDone: number,
  today: string,
): OrthoProgress {
  return {
    visitsDone,
    plannedVisits: c.plannedVisits,
    monthsElapsed: wholeMonthsBetween(c.startDate, today),
    estimatedMonths: c.estimatedMonths,
    percent: wholePercent(visitsDone, c.plannedVisits),
  };
}

/**
 * «Atrasado»: el último control (o, sin controles, el inicio del caso) fue
 * hace MÁS de intervalo + 15 días, contados en días civiles de la sede.
 */
export function daysSinceLastVisit(
  lastVisitDate: string | null,
  startDate: string,
  today: string,
): number {
  const reference = lastVisitDate ?? startDate;
  return Math.max(0, civilDaysInclusive(reference, today) - 1);
}

export function isOverdue(
  lastVisitDate: string | null,
  startDate: string,
  intervalDays: number,
  today: string,
): boolean {
  return (
    daysSinceLastVisit(lastVisitDate, startDate, today) >
    intervalDays + ORTHO_OVERDUE_GRACE_DAYS
  );
}

export const ORTHO_STATUS_LABELS = STATUS_LABELS;
