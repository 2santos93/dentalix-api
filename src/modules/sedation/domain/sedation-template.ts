/**
 * Plantilla de la hoja de sedación (DX-407). Hoy hay UNA, la de plataforma,
 * fija en el código; DX-409 hará la plantilla configurable por clínica en
 * Ajustes y la servirá por el mismo puerto (`SedationTemplateSource`): las
 * reglas (`sedation-rules.ts`) y los casos de uso solo leen esta interfaz,
 * nunca las constantes de abajo.
 *
 * Contenido: hoja de referencia de la AAPD (*Procedural Sedation Record*,
 * nov-2024) y guía de sedación de la ADA (oct-2025): valoración previa con
 * ASA, ayuno, vía aérea (Mallampati), peso, talla e IMC, acompañante adulto y
 * consentimiento; checklist del equipo (monitores, O2 y aspiración, kit de
 * emergencia y reversores con dosis por peso); constantes por tiempo; egreso
 * con 6 criterios (o Aldrete modificado ≥ 9). Fuentes en
 * dentalix-docs/loop/INVESTIGACION.md, «Matriz 93».
 *
 * Cada hoja guarda la `version` y el intervalo con que se abrió, y el
 * checklist y el egreso copian los textos de sus ítems: cambiar la plantilla
 * no reescribe lo ya registrado.
 */

/** Campos de la valoración previa que una plantilla puede exigir. */
export type SedationAssessmentField =
  'ASA' | 'FASTING' | 'MALLAMPATI' | 'WEIGHT' | 'HEIGHT' | 'ESCORT' | 'CONSENT';

/** Constantes de una toma que una plantilla puede exigir. */
export type SedationVitalField =
  | 'SPO2'
  | 'HEART_RATE'
  | 'BLOOD_PRESSURE'
  | 'RESPIRATORY_RATE'
  | 'ETCO2'
  | 'SEDATION_LEVEL';

export interface SedationChecklistItemDef {
  code: string;
  label: string;
  required: boolean;
}

export interface SedationDischargeCriterionDef {
  code: string;
  label: string;
}

export type SedationTemplateSourceKind = 'PLATFORM' | 'CLINIC';

export interface SedationTemplate {
  version: string;
  source: SedationTemplateSourceKind;
  /** Minutos máximos entre dos tomas mientras dura la sedación. */
  vitalsIntervalMinutes: number;
  requiredAssessment: readonly SedationAssessmentField[];
  checklist: readonly SedationChecklistItemDef[];
  requiredVitals: readonly SedationVitalField[];
  dischargeCriteria: readonly SedationDischargeCriterionDef[];
  /** Aldrete modificado (0–10) desde el que se puede dar el alta. */
  aldreteMinimum: number;
}

export const PLATFORM_SEDATION_TEMPLATE_VERSION = 'SEDATION_PLATFORM_V1';

export const PLATFORM_SEDATION_TEMPLATE: SedationTemplate = {
  version: PLATFORM_SEDATION_TEMPLATE_VERSION,
  source: 'PLATFORM',
  vitalsIntervalMinutes: 5,
  requiredAssessment: [
    'ASA',
    'FASTING',
    'MALLAMPATI',
    'WEIGHT',
    'HEIGHT',
    'ESCORT',
    'CONSENT',
  ],
  checklist: [
    {
      code: 'MONITORS_TESTED',
      label: 'Monitores probados (pulsioxímetro y tensiómetro)',
      required: true,
    },
    {
      code: 'OXYGEN_SUCTION',
      label: 'Oxígeno y aspiración listos',
      required: true,
    },
    {
      code: 'EMERGENCY_KIT',
      label: 'Kit de emergencia revisado',
      required: true,
    },
    {
      code: 'REVERSAL_AGENTS',
      label:
        'Reversores preparados con la dosis por peso (naloxona y flumazenil)',
      required: true,
    },
    {
      code: 'NO_CONTRAINDICATION',
      label: 'Sin contraindicación hoy (ayuno y cambios en la salud revisados)',
      required: true,
    },
    {
      code: 'TWO_ADULTS_TRANSPORT',
      label: 'Dos adultos para el traslado (niño en coche)',
      required: false,
    },
  ],
  requiredVitals: [
    'SPO2',
    'HEART_RATE',
    'BLOOD_PRESSURE',
    'RESPIRATORY_RATE',
    'SEDATION_LEVEL',
  ],
  dischargeCriteria: [
    {
      code: 'CARDIOVASCULAR_STABLE',
      label: 'Función cardiovascular satisfactoria y estable',
    },
    { code: 'AIRWAY_PATENT', label: 'Vía aérea permeable y estable' },
    { code: 'EASILY_AROUSABLE', label: 'Despierta con facilidad' },
    { code: 'PROTECTIVE_REFLEXES', label: 'Reflejos protectores intactos' },
    {
      code: 'BASELINE_SPEECH_SITTING',
      label: 'Habla y se sienta (o se mantiene) como antes de la sedación',
    },
    { code: 'HYDRATION', label: 'Hidratación adecuada' },
  ],
  aldreteMinimum: 9,
};
