import type {
  Allergy,
  Condition,
  ConditionStatus,
  Habits,
  MedicalHistory,
  Medication,
  Surgery,
} from '../../medical-history/domain/entities/medical-history.entity';
import type { MedicalHistoryVersionData } from '../../medical-history/domain/ports/medical-history-repository.port';
import { deriveSafetyFlags } from '../../medical-history/domain/safety-flags';
import {
  ANAMNESIS_CONDITIONS,
  ANAMNESIS_CONDITION_CODES,
  type AnamnesisAnswers,
  type YesNoUnknown,
} from './anamnesis-questionnaire';

export const MISSING_ALLERGIES_MESSAGE =
  'Indique al menos una alergia o cambie la respuesta.';
export const MISSING_MEDICATIONS_MESSAGE =
  'Indique al menos un medicamento o cambie la respuesta.';
export const MISSING_SURGERIES_MESSAGE =
  'Indique al menos una cirugía u hospitalización o cambie la respuesta.';
export const INCOMPLETE_CONDITIONS_MESSAGE =
  'Conteste todas las preguntas de enfermedades.';
export const BLANK_ALLERGY_MESSAGE = 'Escriba el nombre de cada alergia.';
export const BLANK_MEDICATION_MESSAGE =
  'Escriba el nombre de cada medicamento.';
export const BLANK_SURGERY_MESSAGE = 'Describa cada cirugía u hospitalización.';

const ALERT_CONDITION_CODES: ReadonlySet<string> = new Set(
  ANAMNESIS_CONDITIONS.filter((c) => c.alert).map((c) => c.codigo),
);
const CONDITION_LABELS = new Map(
  ANAMNESIS_CONDITIONS.map((c) => [c.codigo, c.etiqueta]),
);
const UNSPECIFIED_ANTICOAGULANT = 'Anticoagulante (sin especificar)';

const blank = (value: string | undefined): boolean => !value?.trim();

/** Texto libre del paciente: sin espacios de más; vacío = ausente. */
function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed : undefined;
}

/**
 * Reglas que cruzan campos (la forma la valida el DTO): un «Sí» con lista
 * exige al menos un elemento con nombre, y las condiciones son exactamente
 * las del cuestionario, cada una una vez. Mensajes en español para el
 * paciente; lista vacía = válido.
 */
export function answersValidationErrors(answers: AnamnesisAnswers): string[] {
  const errors: string[] = [];
  const allergies = answers.allergies.items ?? [];
  if (answers.allergies.answer === 'SI') {
    if (allergies.length === 0) errors.push(MISSING_ALLERGIES_MESSAGE);
    else if (allergies.some((a) => blank(a.alergeno))) {
      errors.push(BLANK_ALLERGY_MESSAGE);
    }
  }
  const meds = answers.medications.items ?? [];
  if (answers.medications.answer === 'SI') {
    if (meds.length === 0) errors.push(MISSING_MEDICATIONS_MESSAGE);
    else if (meds.some((m) => blank(m.nombre))) {
      errors.push(BLANK_MEDICATION_MESSAGE);
    }
  }
  const surgeries = answers.surgeries.items ?? [];
  if (answers.surgeries.answer === 'SI') {
    if (surgeries.length === 0) errors.push(MISSING_SURGERIES_MESSAGE);
    else if (surgeries.some((s) => blank(s.descripcion))) {
      errors.push(BLANK_SURGERY_MESSAGE);
    }
  }
  const codes = answers.conditions.map((c) => c.codigo);
  const unique = new Set(codes);
  if (
    unique.size !== codes.length ||
    unique.size !== ANAMNESIS_CONDITION_CODES.size ||
    codes.some((code) => !ANAMNESIS_CONDITION_CODES.has(code))
  ) {
    errors.push(INCOMPLETE_CONDITIONS_MESSAGE);
  }
  return errors;
}

const CONDITION_STATUS: Record<YesNoUnknown, ConditionStatus> = {
  SI: 'SI',
  NO: 'NO',
  NO_SE: 'DESCONOCE',
};

/**
 * Lista con «Sí / No / No sé»: «Sí» = lo que declaró, «No» = nada, «No sé» =
 * lo que ya había (el paciente no aporta información nueva).
 */
function listFrom<T, U>(
  answer: YesNoUnknown,
  items: U[] | undefined,
  map: (item: U) => T,
  previous: T[],
): T[] {
  if (answer === 'SI') return (items ?? []).map(map);
  if (answer === 'NO') return [];
  return previous;
}

function allergiesFrom(
  answers: AnamnesisAnswers,
  previous: Allergy[],
): Allergy[] {
  return listFrom(
    answers.allergies.answer,
    answers.allergies.items,
    (a) => ({
      alergeno: clean(a.alergeno) ?? '',
      tipo: a.tipo,
      ...(clean(a.reaccion) ? { reaccion: clean(a.reaccion) } : {}),
      severidad: a.severidad,
      // Cualquier alergia que declare el paciente es una alerta hasta que el
      // profesional diga lo contrario al revisarla.
      esAlerta: true,
    }),
    previous,
  );
}

function conditionsFrom(
  answers: AnamnesisAnswers,
  previous: Condition[],
): Condition[] {
  // Las condiciones que la clínica anotó fuera del cuestionario siguen igual.
  const kept = previous.filter((c) => !ANAMNESIS_CONDITION_CODES.has(c.codigo));
  const answered = answers.conditions.map((c): Condition => {
    const estado = CONDITION_STATUS[c.answer];
    const nota = clean(c.nota);
    return {
      codigo: c.codigo,
      etiqueta: CONDITION_LABELS.get(c.codigo) ?? c.codigo,
      estado,
      esAlerta: estado === 'SI' && ALERT_CONDITION_CODES.has(c.codigo),
      ...(nota ? { nota } : {}),
    };
  });
  return [...kept, ...answered];
}

function isAnticoagulant(nombre: string): boolean {
  return deriveSafetyFlags({ medications: [{ nombre, esAlerta: false }] })
    .safetyFlags.anticoagulantes;
}

function medicationsFrom(
  answers: AnamnesisAnswers,
  previous: Medication[],
): Medication[] {
  const meds = listFrom(
    answers.medications.answer,
    answers.medications.items,
    (m): Medication => {
      const nombre = clean(m.nombre) ?? '';
      const dosis = clean(m.dosis);
      const frecuencia = clean(m.frecuencia);
      return {
        nombre,
        ...(dosis ? { dosis } : {}),
        ...(frecuencia ? { frecuencia } : {}),
        esAlerta: isAnticoagulant(nombre),
      };
    },
    previous,
  );
  if (answers.anticoagulants.answer !== 'SI') return meds;
  // «Sí» a anticoagulantes: si ya figura uno en la lista basta con marcarlo;
  // si no, se añade (con su nombre o sin especificar). `deriveSafetyFlags`
  // reconoce «anticoagulante» como palabra clave, así que la bandera se
  // enciende aunque el paciente no sepa el nombre.
  if (meds.some((m) => isAnticoagulant(m.nombre))) {
    return meds.map((m) =>
      isAnticoagulant(m.nombre) ? { ...m, esAlerta: true } : m,
    );
  }
  const detail = clean(answers.anticoagulants.detail);
  const nombre = detail
    ? isAnticoagulant(detail)
      ? detail
      : `Anticoagulante: ${detail}`
    : UNSPECIFIED_ANTICOAGULANT;
  return [...meds, { nombre, esAlerta: true }];
}

function habitsFrom(
  answers: AnamnesisAnswers,
  previous: Habits | null,
): Habits {
  const habits: Habits = { ...(previous ?? {}) };
  const { tabaquismo, alcohol, bruxismo } = answers.habits;
  if (tabaquismo.answer === 'SI') {
    habits.tabaquismo = {
      activo: true,
      ...(tabaquismo.porDia !== undefined ? { porDia: tabaquismo.porDia } : {}),
    };
  } else if (tabaquismo.answer === 'NO') {
    habits.tabaquismo = { activo: false };
  }
  if (alcohol.answer === 'SI') {
    const frecuencia = clean(alcohol.frecuencia);
    habits.alcohol = { activo: true, ...(frecuencia ? { frecuencia } : {}) };
  } else if (alcohol.answer === 'NO') {
    habits.alcohol = { activo: false };
  }
  if (bruxismo.answer !== 'NO_SE') habits.bruxismo = bruxismo.answer === 'SI';
  return habits;
}

function surgeriesFrom(
  answers: AnamnesisAnswers,
  previous: Surgery[],
): Surgery[] {
  return listFrom(
    answers.surgeries.answer,
    answers.surgeries.items,
    (s): Surgery => {
      const fecha = clean(s.fecha);
      return {
        descripcion: clean(s.descripcion) ?? '',
        ...(fecha ? { fecha } : {}),
      };
    },
    previous,
  );
}

/**
 * La versión que propone el envío del paciente sobre la vigente (o sobre
 * nada). Solo cambian los bloques que pregunta el cuestionario; lo demás
 * (antecedentes odontológicos, signos vitales, antecedentes familiares,
 * notas, hábitos de higiene) sigue tal cual. Las banderas NO se calculan
 * aquí: las deriva `deriveSafetyFlags` al crear la versión.
 */
export function proposeVersionFromAnswers(
  answers: AnamnesisAnswers,
  current: MedicalHistory | null,
): MedicalHistoryVersionData {
  const pregnancy = answers.pregnancy;
  const embarazo =
    pregnancy.answer === 'NO_SE'
      ? (current?.safetyFlags.embarazo ?? false)
      : pregnancy.answer === 'SI';
  const semanasEmbarazo = !embarazo
    ? undefined
    : pregnancy.answer === 'SI'
      ? pregnancy.semanas
      : current?.safetyFlags.semanasEmbarazo;
  return {
    allergies: allergiesFrom(answers, current?.allergies ?? []),
    conditions: conditionsFrom(answers, current?.conditions ?? []),
    medications: medicationsFrom(answers, current?.medications ?? []),
    habits: habitsFrom(answers, current?.habits ?? null),
    dentalHistory: current?.dentalHistory ?? undefined,
    surgeries: surgeriesFrom(answers, current?.surgeries ?? []),
    vitalSigns: current?.vitalSigns ?? undefined,
    familyHistory: current?.familyHistory ?? undefined,
    notes: current?.notes ?? undefined,
    embarazo,
    ...(semanasEmbarazo !== undefined ? { semanasEmbarazo } : {}),
  };
}

/** Cuántas preguntas contestó «Sí» (lo primero que mira el profesional). */
export function countAffirmativeAnswers(answers: AnamnesisAnswers): number {
  const flat: YesNoUnknown[] = [
    answers.allergies.answer,
    ...answers.conditions.map((c) => c.answer),
    answers.medications.answer,
    answers.anticoagulants.answer,
    answers.habits.tabaquismo.answer,
    answers.habits.alcohol.answer,
    answers.habits.bruxismo.answer,
    answers.pregnancy.answer,
    answers.surgeries.answer,
  ];
  return flat.filter((a) => a === 'SI').length;
}
