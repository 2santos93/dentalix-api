import type {
  AnswerStatus,
  Habits,
  SafetyFlags,
} from './entities/medical-history.entity';
import type { MedicalHistoryVersionData } from './ports/medical-history-repository.port';

/**
 * Hábitos y embarazo tri-estado (Sí / No / No sabe; ausente = sin responder)
 * sobre una historia APPEND-ONLY: las versiones ya guardadas no se reescriben
 * (la BD prohíbe el UPDATE). Aquí está la única traducción de lo que
 * registraron, en dos sentidos:
 * - al LEER una versión (`readStoredHabits`, `readStoredPregnancy`);
 * - al RECIBIR una versión de un cliente anterior (`toVersionData`: el
 *   `embarazo: true` y los booleanos de hábitos de la forma vieja).
 */
export const ANSWER_STATUSES = ['SI', 'NO', 'DESCONOCE'] as const;

export function isAnswerStatus(value: unknown): value is AnswerStatus {
  return (ANSWER_STATUSES as readonly unknown[]).includes(value);
}

/**
 * Una respuesta guardada o recibida: tri-estado tal cual; booleano de la
 * forma anterior → `true` «Sí», `false` «No» (el formulario solo enviaba
 * `false` si se contestó «No»; lo no preguntado quedaba ausente). Cualquier
 * otra cosa = sin responder.
 */
export function answerOf(value: unknown): AnswerStatus | undefined {
  if (isAnswerStatus(value)) return value;
  if (value === true) return 'SI';
  if (value === false) return 'NO';
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const numberOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const stringOf = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

function prune<T extends object>(obj: T): T | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

/**
 * Hábitos en la forma tri-estado, vengan de una versión nueva o de una
 * anterior (booleanos). `null` si no hay ninguno. Solo cambia la FORMA, no
 * lo que se respondió.
 */
export function readStoredHabits(raw: unknown): Habits | null {
  if (!isRecord(raw)) return null;
  const smoking = isRecord(raw.tabaquismo) ? raw.tabaquismo : undefined;
  const drinking = isRecord(raw.alcohol) ? raw.alcohol : undefined;
  const hygiene = isRecord(raw.higieneOral) ? raw.higieneOral : undefined;
  const smokingAnswer = smoking && answerOf(smoking.estado ?? smoking.activo);
  const drinkingAnswer =
    drinking && answerOf(drinking.estado ?? drinking.activo);
  const habits: Habits = {
    tabaquismo: smokingAnswer
      ? prune({
          estado: smokingAnswer,
          porDia: numberOf(smoking?.porDia),
          anios: numberOf(smoking?.anios),
        })
      : undefined,
    alcohol: drinkingAnswer
      ? prune({
          estado: drinkingAnswer,
          frecuencia: stringOf(drinking?.frecuencia),
        })
      : undefined,
    sustancias: answerOf(raw.sustancias),
    bruxismo: answerOf(raw.bruxismo),
    higieneOral: hygiene
      ? prune({
          cepilladoPorDia: numberOf(hygiene.cepilladoPorDia),
          hilo: answerOf(hygiene.hilo),
          enjuague: answerOf(hygiene.enjuague),
          cremaConFluor: answerOf(hygiene.cremaConFluor),
        })
      : undefined,
    dieta: stringOf(raw.dieta),
  };
  return prune(habits) ?? null;
}

/**
 * Embarazo de una versión. Con la columna (`pregnancy`), lo respondido. Sin
 * ella (versiones anteriores), solo se guardaba la bandera: `true` era un
 * «Sí»; `false` no distingue «No» de «no se preguntó», así que es `null`
 * (sin responder), nunca un «No» que nadie registró.
 */
export function readStoredPregnancy(
  column: AnswerStatus | null,
  flags: Pick<SafetyFlags, 'embarazo'>,
): AnswerStatus | null {
  if (column !== null) return column;
  return flags.embarazo ? 'SI' : null;
}

/** Lo que manda un cliente: la forma nueva y, deprecado, `embarazo`. */
export type MedicalHistoryInput = Omit<
  MedicalHistoryVersionData,
  'habits' | 'pregnancy'
> & {
  habits?: unknown;
  pregnancy?: AnswerStatus;
  /** Deprecado: solo `true` dice algo («Sí»); `false` = sin responder. */
  embarazo?: boolean;
};

/**
 * La versión a guardar a partir de lo recibido: solo los campos conocidos
 * (defensivo: nada de `tenantId`/`version`/`safetyFlags` colados), hábitos
 * en la forma tri-estado y el embarazo de `pregnancy` (o, de un cliente
 * anterior, `embarazo: true` → «Sí»). Las semanas solo con «Sí».
 */
export function toVersionData(
  input: MedicalHistoryInput,
): MedicalHistoryVersionData {
  const pregnancy =
    input.pregnancy ?? (input.embarazo === true ? 'SI' : undefined);
  return {
    allergies: input.allergies,
    conditions: input.conditions,
    medications: input.medications,
    habits: readStoredHabits(input.habits) ?? undefined,
    dentalHistory: input.dentalHistory,
    surgeries: input.surgeries,
    vitalSigns: input.vitalSigns,
    familyHistory: input.familyHistory,
    notes: input.notes,
    ...(pregnancy ? { pregnancy } : {}),
    ...(pregnancy === 'SI' && input.semanasEmbarazo !== undefined
      ? { semanasEmbarazo: input.semanasEmbarazo }
      : {}),
  };
}
