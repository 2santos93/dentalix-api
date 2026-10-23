import {
  ANAMNESIS_CONDITIONS,
  type AnamnesisAnswers,
} from '../anamnesis-questionnaire';

/** Respuestas con todo «No»: el punto de partida de los tests (DX-099). */
export function allNoAnswers(): AnamnesisAnswers {
  return {
    allergies: { answer: 'NO' },
    conditions: ANAMNESIS_CONDITIONS.map((c) => ({
      codigo: c.codigo,
      answer: 'NO' as const,
    })),
    medications: { answer: 'NO' },
    anticoagulants: { answer: 'NO' },
    habits: {
      tabaquismo: { answer: 'NO' },
      alcohol: { answer: 'NO' },
      bruxismo: { answer: 'NO' },
    },
    pregnancy: { answer: 'NO' },
    surgeries: { answer: 'NO' },
  };
}
