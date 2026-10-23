import type {
  Allergy,
  AllergySeverity,
  AllergyType,
  Condition,
  ConditionStatus,
  Habits,
  MedicalHistory,
  Medication,
  Surgery,
} from '../../medical-history/domain/entities/medical-history.entity';
import type { MedicalHistoryVersionData } from '../../medical-history/domain/ports/medical-history-repository.port';

export type HistoryDiffChange = 'ADDED' | 'REMOVED' | 'CHANGED';
export type HistoryDiffSection =
  | 'ALLERGIES'
  | 'CONDITIONS'
  | 'MEDICATIONS'
  | 'HABITS'
  | 'PREGNANCY'
  | 'SURGERIES';

/** Una línea de la vista de revisión: qué cambia, de qué a qué. */
export interface HistoryDiffEntry {
  section: HistoryDiffSection;
  label: string;
  change: HistoryDiffChange;
  /** Cómo está en la versión vigente; `null` si no estaba. */
  before: string | null;
  /** Cómo quedaría; `null` si se quita. */
  after: string | null;
  /** Hay un «Sí» a un lado u otro: se revisa primero. */
  affirmative: boolean;
}

export interface HistoryDiff {
  hasPreviousVersion: boolean;
  /** Los «Sí» primero; dentro de cada grupo, en el orden del cuestionario. */
  entries: HistoryDiffEntry[];
  /** Cuántos elementos comparados siguen igual (no se listan). */
  unchangedCount: number;
}

const TYPE_LABELS: Record<AllergyType, string> = {
  MEDICAMENTO: 'Medicamento',
  MATERIAL: 'Material',
  ALIMENTO: 'Alimento',
  AMBIENTAL: 'Ambiental',
};
const SEVERITY_LABELS: Record<AllergySeverity, string> = {
  LEVE: 'Leve',
  MODERADA: 'Moderada',
  ANAFILAXIA: 'Anafilaxia',
};
const STATUS_LABELS: Record<ConditionStatus, string> = {
  SI: 'Sí',
  NO: 'No',
  DESCONOCE: 'Desconoce',
};
const YES = 'Sí';
const NO = 'No';
const NONE = 'Ninguna';

/** Clave de emparejamiento: sin tildes, mayúsculas ni espacios de más. */
function key(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

const join = (...parts: (string | undefined)[]): string =>
  parts.filter((p): p is string => !!p && p.trim() !== '').join(' · ');

const allergyValue = (a: Allergy): string =>
  join(TYPE_LABELS[a.tipo], SEVERITY_LABELS[a.severidad], a.reaccion);
const medicationValue = (m: Medication): string =>
  join(m.dosis, m.frecuencia) || YES;
const surgeryValue = (s: Surgery): string => s.fecha?.trim() || YES;
const conditionValue = (c: Condition): string =>
  join(STATUS_LABELS[c.estado], c.nota);

interface Collector {
  entries: HistoryDiffEntry[];
  unchanged: number;
}

/** Compara dos listas emparejando por nombre. */
function diffList<T>(
  out: Collector,
  section: HistoryDiffSection,
  sectionLabel: string,
  before: T[] | null,
  after: T[],
  name: (item: T) => string,
  value: (item: T) => string,
): void {
  if (before === null && after.length === 0) {
    out.entries.push({
      section,
      label: sectionLabel,
      change: 'ADDED',
      before: null,
      after: NONE,
      affirmative: false,
    });
    return;
  }
  const previous = new Map((before ?? []).map((i) => [key(name(i)), i]));
  const seen = new Set<string>();
  for (const item of after) {
    const k = key(name(item));
    seen.add(k);
    const old = previous.get(k);
    if (!old) {
      out.entries.push({
        section,
        label: name(item),
        change: 'ADDED',
        before: null,
        after: value(item),
        affirmative: true,
      });
    } else if (value(old) !== value(item)) {
      out.entries.push({
        section,
        label: name(old),
        change: 'CHANGED',
        before: value(old),
        after: value(item),
        affirmative: true,
      });
    } else {
      out.unchanged += 1;
    }
  }
  for (const [k, old] of previous) {
    if (seen.has(k)) continue;
    out.entries.push({
      section,
      label: name(old),
      change: 'REMOVED',
      before: value(old),
      after: null,
      affirmative: true,
    });
  }
}

function diffConditions(
  out: Collector,
  before: Condition[] | null,
  after: Condition[],
): void {
  const previous = new Map((before ?? []).map((c) => [c.codigo, c]));
  const seen = new Set<string>();
  for (const c of after) {
    seen.add(c.codigo);
    const old = previous.get(c.codigo);
    const affirmative = c.estado === 'SI' || old?.estado === 'SI';
    if (!old) {
      out.entries.push({
        section: 'CONDITIONS',
        label: c.etiqueta,
        change: 'ADDED',
        before: null,
        after: conditionValue(c),
        affirmative,
      });
    } else if (conditionValue(old) !== conditionValue(c)) {
      out.entries.push({
        section: 'CONDITIONS',
        label: old.etiqueta,
        change: 'CHANGED',
        before: conditionValue(old),
        after: conditionValue(c),
        affirmative,
      });
    } else {
      out.unchanged += 1;
    }
  }
  for (const old of before ?? []) {
    if (seen.has(old.codigo)) continue;
    out.entries.push({
      section: 'CONDITIONS',
      label: old.etiqueta,
      change: 'REMOVED',
      before: conditionValue(old),
      after: null,
      affirmative: old.estado === 'SI',
    });
  }
}

/** Un valor escalar (hábito, embarazo): `undefined` = no se sabe / no se toca. */
function diffScalar(
  out: Collector,
  section: HistoryDiffSection,
  label: string,
  before: string | undefined,
  after: string | undefined,
): void {
  if (after === undefined) {
    if (before !== undefined) out.unchanged += 1;
    return;
  }
  const affirmative = after.startsWith(YES) || !!before?.startsWith(YES);
  if (before === undefined) {
    out.entries.push({
      section,
      label,
      change: 'ADDED',
      before: null,
      after,
      affirmative,
    });
  } else if (before !== after) {
    out.entries.push({
      section,
      label,
      change: 'CHANGED',
      before,
      after,
      affirmative,
    });
  } else {
    out.unchanged += 1;
  }
}

function smoking(h: Habits | null | undefined): string | undefined {
  const t = h?.tabaquismo;
  if (!t) return undefined;
  if (!t.activo) return NO;
  return t.porDia !== undefined ? `${YES} (${t.porDia} al día)` : YES;
}
function alcohol(h: Habits | null | undefined): string | undefined {
  const a = h?.alcohol;
  if (!a) return undefined;
  if (!a.activo) return NO;
  return a.frecuencia ? `${YES} (${a.frecuencia})` : YES;
}
function bruxism(h: Habits | null | undefined): string | undefined {
  if (h?.bruxismo === undefined) return undefined;
  return h.bruxismo ? YES : NO;
}
function pregnancy(embarazo: boolean, semanas: number | undefined): string {
  if (!embarazo) return NO;
  return semanas !== undefined ? `${YES} (${semanas} semanas)` : YES;
}

/**
 * Diferencias entre la versión vigente (o ninguna) y la que propone el envío
 * del paciente, en los bloques que pregunta el cuestionario. Sin versión
 * previa todo es «nuevo». Lo que no cambia no se lista (solo se cuenta).
 */
export function diffMedicalHistory(
  current: MedicalHistory | null,
  proposed: MedicalHistoryVersionData,
): HistoryDiff {
  const out: Collector = { entries: [], unchanged: 0 };
  const none = <T>(list: T[] | undefined): T[] | null =>
    current ? (list ?? []) : null;

  diffList(
    out,
    'ALLERGIES',
    'Alergias',
    none(current?.allergies),
    proposed.allergies ?? [],
    (a) => a.alergeno,
    allergyValue,
  );
  diffConditions(out, none(current?.conditions), proposed.conditions ?? []);
  diffList(
    out,
    'MEDICATIONS',
    'Medicamentos',
    none(current?.medications),
    proposed.medications ?? [],
    (m) => m.nombre,
    medicationValue,
  );
  diffScalar(
    out,
    'HABITS',
    'Tabaquismo',
    smoking(current?.habits),
    smoking(proposed.habits),
  );
  diffScalar(
    out,
    'HABITS',
    'Alcohol',
    alcohol(current?.habits),
    alcohol(proposed.habits),
  );
  diffScalar(
    out,
    'HABITS',
    'Bruxismo',
    bruxism(current?.habits),
    bruxism(proposed.habits),
  );
  diffScalar(
    out,
    'PREGNANCY',
    'Embarazo',
    current
      ? pregnancy(
          current.safetyFlags.embarazo,
          current.safetyFlags.semanasEmbarazo,
        )
      : undefined,
    proposed.embarazo === undefined
      ? undefined
      : pregnancy(proposed.embarazo, proposed.semanasEmbarazo),
  );
  diffList(
    out,
    'SURGERIES',
    'Cirugías y hospitalizaciones',
    none(current?.surgeries),
    proposed.surgeries ?? [],
    (s) => s.descripcion,
    surgeryValue,
  );

  return {
    hasPreviousVersion: current !== null,
    entries: [
      ...out.entries.filter((e) => e.affirmative),
      ...out.entries.filter((e) => !e.affirmative),
    ],
    unchangedCount: out.unchanged,
  };
}
