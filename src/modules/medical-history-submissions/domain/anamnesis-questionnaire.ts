import type {
  AllergySeverity,
  AllergyType,
} from '../../medical-history/domain/entities/medical-history.entity';

/**
 * Cuestionario de anamnesis que responde el paciente por enlace (DX-099).
 * Fijo y versionado EN CÓDIGO (no lo configura la clínica): la versión viaja
 * con cada envío (`questionnaireVersion`), así que cambiar una pregunta exige
 * subir la versión. Sale de la MISMA estructura que el formulario del
 * personal (`medical-history.entity.ts`): alergias, condiciones (con los
 * mismos `codigo` que alimentan `deriveSafetyFlags`), medicación, hábitos,
 * embarazo y cirugías. La web pinta el formulario público a partir de esta
 * definición (`GET /public/medical-history/:token`).
 */
export const ANAMNESIS_QUESTIONNAIRE_VERSION = '2026-10-v1';

/** Respuesta a una pregunta Sí/No/No sé. */
export type YesNoUnknown = 'SI' | 'NO' | 'NO_SE';
export const YES_NO_UNKNOWN: readonly YesNoUnknown[] = ['SI', 'NO', 'NO_SE'];

/**
 * Condiciones que se preguntan una a una. Mismos `codigo` y etiquetas que el
 * checklist del personal (web: `STANDARD_CONDITIONS`), redactadas para el
 * paciente. `alert`: la condición marcada «Sí» entra como alerta en la ficha
 * (las de profilaxis antibiótica, la diabetes y los trastornos de la
 * coagulación, que cambian lo que se hace en el sillón).
 */
export const ANAMNESIS_CONDITIONS: readonly {
  codigo: string;
  etiqueta: string;
  pregunta: string;
  alert: boolean;
}[] = [
  {
    codigo: 'HIPERTENSION',
    etiqueta: 'Hipertensión',
    pregunta: '¿Tiene la tensión alta (hipertensión)?',
    alert: false,
  },
  {
    codigo: 'CARDIOPATIA',
    etiqueta: 'Enfermedad cardíaca',
    pregunta: '¿Tiene alguna enfermedad del corazón?',
    alert: false,
  },
  {
    codigo: 'VALVULOPATIA',
    etiqueta: 'Soplo / valvulopatía',
    pregunta:
      '¿Le han dicho que tiene un soplo o una enfermedad de las válvulas del corazón?',
    alert: true,
  },
  {
    codigo: 'PROTESIS_VALVULAR',
    etiqueta: 'Prótesis valvular cardíaca',
    pregunta: '¿Tiene una válvula del corazón artificial (prótesis valvular)?',
    alert: true,
  },
  {
    codigo: 'ENDOCARDITIS_PREVIA',
    etiqueta: 'Endocarditis infecciosa previa',
    pregunta: '¿Ha tenido alguna vez una infección del corazón (endocarditis)?',
    alert: true,
  },
  {
    codigo: 'DIABETES',
    etiqueta: 'Diabetes',
    pregunta: '¿Tiene diabetes?',
    alert: true,
  },
  {
    codigo: 'ASMA',
    etiqueta: 'Asma / respiratorio',
    pregunta: '¿Tiene asma u otra enfermedad respiratoria?',
    alert: false,
  },
  {
    codigo: 'HEPATITIS',
    etiqueta: 'Hepatitis / hígado',
    pregunta: '¿Ha tenido hepatitis u otra enfermedad del hígado?',
    alert: false,
  },
  {
    codigo: 'RENAL',
    etiqueta: 'Enfermedad renal',
    pregunta: '¿Tiene alguna enfermedad de los riñones?',
    alert: false,
  },
  {
    codigo: 'COAGULACION',
    etiqueta: 'Trastorno de coagulación / sangrado',
    pregunta: '¿Sangra mucho al cortarse o tiene un problema de coagulación?',
    alert: true,
  },
  {
    codigo: 'INMUNOSUPRESION',
    etiqueta: 'Inmunosupresión',
    pregunta:
      '¿Tiene las defensas bajas o toma medicamentos que las bajan (inmunosupresión)?',
    alert: true,
  },
  {
    codigo: 'REEMPLAZO_ARTICULAR',
    etiqueta: 'Reemplazo articular / prótesis',
    pregunta: '¿Tiene una prótesis de cadera, rodilla u otra articulación?',
    alert: true,
  },
  {
    codigo: 'EPILEPSIA',
    etiqueta: 'Epilepsia / convulsiones',
    pregunta: '¿Tiene epilepsia o ha tenido convulsiones?',
    alert: false,
  },
  {
    codigo: 'CANCER',
    etiqueta: 'Cáncer / quimio-radioterapia',
    pregunta: '¿Ha tenido cáncer o ha recibido quimioterapia o radioterapia?',
    alert: false,
  },
  {
    codigo: 'OSTEOPOROSIS',
    etiqueta: 'Osteoporosis / bifosfonatos',
    pregunta: '¿Tiene osteoporosis o toma medicamentos para los huesos?',
    alert: false,
  },
];

export const ANAMNESIS_CONDITION_CODES: ReadonlySet<string> = new Set(
  ANAMNESIS_CONDITIONS.map((c) => c.codigo),
);

/** Topes de lo que escribe el paciente (texto libre). */
export const ANSWER_LIMITS = {
  text: 200,
  note: 500,
  listItems: 20,
  weeks: 45,
  perDay: 200,
} as const;

/** Una alergia declarada por el paciente. */
export interface AllergyAnswer {
  alergeno: string;
  tipo: AllergyType;
  reaccion?: string;
  severidad: AllergySeverity;
}
/** Un medicamento que toma. */
export interface MedicationAnswer {
  nombre: string;
  dosis?: string;
  frecuencia?: string;
}
/** Una cirugía u hospitalización. */
export interface SurgeryAnswer {
  descripcion: string;
  fecha?: string;
}

/**
 * Lo que envía el paciente (y lo que se guarda en `answers`). Cada bloque
 * lleva su Sí/No/No sé y, si contestó «Sí», el seguimiento.
 */
export interface AnamnesisAnswers {
  allergies: { answer: YesNoUnknown; items?: AllergyAnswer[] };
  conditions: { codigo: string; answer: YesNoUnknown; nota?: string }[];
  medications: { answer: YesNoUnknown; items?: MedicationAnswer[] };
  anticoagulants: { answer: YesNoUnknown; detail?: string };
  habits: {
    tabaquismo: { answer: YesNoUnknown; porDia?: number };
    alcohol: { answer: YesNoUnknown; frecuencia?: string };
    bruxismo: { answer: YesNoUnknown };
  };
  pregnancy: { answer: YesNoUnknown; semanas?: number };
  surgeries: { answer: YesNoUnknown; items?: SurgeryAnswer[] };
}

/** Tipo de seguimiento que se abre al contestar «Sí». */
export type FollowUpKind =
  | 'ALLERGY_LIST'
  | 'MEDICATION_LIST'
  | 'SURGERY_LIST'
  | 'TEXT'
  | 'NUMBER'
  | 'NOTE';

export interface QuestionDefinition {
  /** Clave estable de la respuesta (p. ej. `allergies`, `condition:DIABETES`). */
  key: string;
  label: string;
  help?: string;
  followUp?: { kind: FollowUpKind; label: string; required: boolean };
}

export interface SectionDefinition {
  key:
    | 'allergies'
    | 'conditions'
    | 'medications'
    | 'habits'
    | 'pregnancy'
    | 'surgeries';
  title: string;
  description?: string;
  questions: QuestionDefinition[];
}

export interface QuestionnaireDefinition {
  version: string;
  answers: YesNoUnknown[];
  answerLabels: Record<YesNoUnknown, string>;
  allergyTypes: { value: AllergyType; label: string }[];
  allergySeverities: { value: AllergySeverity; label: string }[];
  limits: typeof ANSWER_LIMITS;
  declaration: string;
  sections: SectionDefinition[];
}

/** El cuestionario tal como lo pinta la web pública. */
export function anamnesisQuestionnaire(): QuestionnaireDefinition {
  return {
    version: ANAMNESIS_QUESTIONNAIRE_VERSION,
    answers: [...YES_NO_UNKNOWN],
    answerLabels: { SI: 'Sí', NO: 'No', NO_SE: 'No sé' },
    allergyTypes: [
      { value: 'MEDICAMENTO', label: 'Medicamento' },
      { value: 'MATERIAL', label: 'Material (látex, metales…)' },
      { value: 'ALIMENTO', label: 'Alimento' },
      { value: 'AMBIENTAL', label: 'Ambiental (polen, ácaros…)' },
    ],
    allergySeverities: [
      { value: 'LEVE', label: 'Leve (picor, ronchas)' },
      { value: 'MODERADA', label: 'Moderada o no lo sé' },
      {
        value: 'ANAFILAXIA',
        label: 'Grave (dificultad para respirar, desmayo)',
      },
    ],
    limits: ANSWER_LIMITS,
    declaration:
      'Declaro que la información que he dado es verdadera y completa según mi conocimiento, y que avisaré a la clínica si cambia.',
    sections: [
      {
        key: 'allergies',
        title: 'Alergias',
        questions: [
          {
            key: 'allergies',
            label:
              '¿Tiene alergia a algún medicamento, a la anestesia, al látex, a algún alimento u otra cosa?',
            followUp: {
              kind: 'ALLERGY_LIST',
              label: 'Escriba cada alergia',
              required: true,
            },
          },
        ],
      },
      {
        key: 'conditions',
        title: 'Enfermedades',
        description:
          'Conteste cada pregunta. Si no está seguro, marque «No sé».',
        questions: ANAMNESIS_CONDITIONS.map((c) => ({
          key: `condition:${c.codigo}`,
          label: c.pregunta,
          followUp: {
            kind: 'NOTE' as const,
            label: 'Detalle (opcional)',
            required: false,
          },
        })),
      },
      {
        key: 'medications',
        title: 'Medicamentos',
        questions: [
          {
            key: 'anticoagulants',
            label:
              '¿Toma medicamentos para «adelgazar la sangre» (anticoagulantes o antiagregantes como warfarina, rivaroxabán, apixabán, clopidogrel o aspirina diaria)?',
            followUp: { kind: 'TEXT', label: '¿Cuál?', required: false },
          },
          {
            key: 'medications',
            label: '¿Toma algún otro medicamento de forma habitual?',
            followUp: {
              kind: 'MEDICATION_LIST',
              label: 'Escriba cada medicamento',
              required: true,
            },
          },
        ],
      },
      {
        key: 'habits',
        title: 'Hábitos',
        questions: [
          {
            key: 'habits.tabaquismo',
            label: '¿Fuma?',
            followUp: {
              kind: 'NUMBER',
              label: 'Cigarrillos al día',
              required: false,
            },
          },
          {
            key: 'habits.alcohol',
            label: '¿Toma bebidas alcohólicas?',
            followUp: {
              kind: 'TEXT',
              label: '¿Con qué frecuencia?',
              required: false,
            },
          },
          {
            key: 'habits.bruxismo',
            label: '¿Aprieta o rechina los dientes (de día o de noche)?',
          },
        ],
      },
      {
        key: 'pregnancy',
        title: 'Embarazo',
        description: 'Si no aplica en su caso, marque «No».',
        questions: [
          {
            key: 'pregnancy',
            label: '¿Está embarazada o podría estarlo?',
            followUp: {
              kind: 'NUMBER',
              label: 'Semanas de embarazo (si las sabe)',
              required: false,
            },
          },
        ],
      },
      {
        key: 'surgeries',
        title: 'Cirugías y hospitalizaciones',
        questions: [
          {
            key: 'surgeries',
            label: '¿Le han operado o ha estado hospitalizado alguna vez?',
            followUp: {
              kind: 'SURGERY_LIST',
              label: 'Escriba cada cirugía u hospitalización',
              required: true,
            },
          },
        ],
      },
    ],
  };
}
