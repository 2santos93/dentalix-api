import type { NoteTemplateDraft } from './note-template-rules';

/**
 * Plantillas de ejemplo en español (DX-170): «Cargar plantillas de ejemplo» en
 * Ajustes y la clínica demo. Texto clínico genérico, sin datos de pacientes;
 * la clínica las edita o desactiva a su gusto. Las comprueba
 * `sample-templates.spec.ts` contra las mismas reglas que la API.
 */
export const SAMPLE_NOTE_TEMPLATES: readonly NoteTemplateDraft[] = [
  {
    name: 'Exploración / control',
    category: 'Diagnóstico',
    body:
      'Motivo de consulta: {{Motivo}}. Exploración extraoral: {{Extraoral}}. ' +
      'Exploración intraoral: {{Intraoral}}. Higiene oral: {{Higiene}}. ' +
      'Plan: {{Plan}}.',
    prompts: [
      {
        label: 'Motivo',
        type: 'ONE',
        options: [
          'Control periódico',
          'Dolor',
          'Estética',
          'Urgencia',
          'Primera vez',
        ],
        defaultValue: 'Control periódico',
      },
      {
        label: 'Extraoral',
        type: 'ONE',
        options: [
          'Sin hallazgos',
          'Asimetría facial',
          'Adenopatías',
          'Dolor ATM',
        ],
        defaultValue: 'Sin hallazgos',
      },
      { label: 'Intraoral', type: 'TEXT', options: [], defaultValue: null },
      {
        label: 'Higiene',
        type: 'ONE',
        options: ['Buena', 'Regular', 'Deficiente'],
        defaultValue: null,
      },
      { label: 'Plan', type: 'TEXT', options: [], defaultValue: null },
    ],
  },
  {
    name: 'Profilaxis',
    category: 'Periodoncia',
    body:
      'Profilaxis con {{Técnica}}. Placa: {{Placa}}. Sangrado al sondaje: ' +
      '{{Sangrado}}. Aplicación de flúor: {{Flúor}}. Instrucciones de higiene ' +
      'oral dadas. Próximo control: {{Próximo control}}.',
    prompts: [
      {
        label: 'Técnica',
        type: 'MULTI',
        options: [
          'Ultrasonido',
          'Curetas',
          'Pasta profiláctica',
          'Chorro de bicarbonato',
        ],
        defaultValue: 'Ultrasonido',
      },
      {
        label: 'Placa',
        type: 'ONE',
        options: ['Escasa', 'Moderada', 'Abundante'],
        defaultValue: null,
      },
      {
        label: 'Sangrado',
        type: 'ONE',
        options: ['No', 'Localizado', 'Generalizado'],
        defaultValue: 'No',
      },
      {
        label: 'Flúor',
        type: 'ONE',
        options: ['Barniz', 'Gel', 'No aplicado'],
        defaultValue: 'Barniz',
      },
      {
        label: 'Próximo control',
        type: 'ONE',
        options: ['3 meses', '6 meses', '12 meses'],
        defaultValue: '6 meses',
      },
    ],
  },
  {
    name: 'Resina',
    category: 'Operatoria',
    body:
      'Diente {{Diente}}, superficie {{Superficie}}. Anestesia: {{Anestesia}}. ' +
      'Aislamiento: {{Aislamiento}}. Remoción de caries, grabado ácido, ' +
      'adhesivo y restauración con {{Material}}. Ajuste oclusal y pulido. ' +
      'Observaciones: {{Observaciones}}.',
    prompts: [
      { label: 'Diente', type: 'TEXT', options: [], defaultValue: null },
      {
        label: 'Superficie',
        type: 'ONE',
        options: ['O', 'M', 'D', 'V', 'L'],
        defaultValue: null,
      },
      {
        label: 'Anestesia',
        type: 'ONE',
        options: [
          'Lidocaína 2 % con epinefrina',
          'Mepivacaína 3 %',
          'Articaína 4 %',
          'Sin anestesia',
        ],
        defaultValue: 'Lidocaína 2 % con epinefrina',
      },
      {
        label: 'Aislamiento',
        type: 'ONE',
        options: ['Absoluto', 'Relativo'],
        defaultValue: 'Absoluto',
      },
      {
        label: 'Material',
        type: 'MULTI',
        options: [
          'Resina A1',
          'Resina A2',
          'Resina A3',
          'Resina fluida',
          'Ionómero de vidrio (base)',
        ],
        defaultValue: 'Resina A2',
      },
      {
        label: 'Observaciones',
        type: 'TEXT',
        options: [],
        defaultValue: 'Sin complicaciones',
      },
    ],
  },
  {
    name: 'Exodoncia simple',
    category: 'Cirugía',
    body:
      'Exodoncia simple del diente {{Diente}}. Anestesia: {{Anestesia}} ' +
      '({{Técnica anestésica}}). Luxación y avulsión sin complicaciones. ' +
      'Hemostasia: {{Hemostasia}}. Se entregan indicaciones postoperatorias ' +
      'escritas. Medicación: {{Medicación}}.',
    prompts: [
      { label: 'Diente', type: 'TEXT', options: [], defaultValue: null },
      {
        label: 'Anestesia',
        type: 'ONE',
        options: [
          'Lidocaína 2 % con epinefrina',
          'Mepivacaína 3 %',
          'Articaína 4 %',
        ],
        defaultValue: 'Lidocaína 2 % con epinefrina',
      },
      {
        label: 'Técnica anestésica',
        type: 'ONE',
        options: ['Infiltrativa', 'Troncular', 'Intraligamentaria'],
        defaultValue: 'Infiltrativa',
      },
      {
        label: 'Hemostasia',
        type: 'MULTI',
        options: ['Compresión con gasa', 'Sutura', 'Esponja hemostática'],
        defaultValue: 'Compresión con gasa',
      },
      {
        label: 'Medicación',
        type: 'TEXT',
        options: [],
        defaultValue: 'Ninguna',
      },
    ],
  },
  {
    name: 'Endodoncia por sesión',
    category: 'Endodoncia',
    body:
      'Endodoncia diente {{Diente}}, sesión {{Sesión}}. Anestesia: ' +
      '{{Anestesia}}. Aislamiento absoluto. Procedimiento: {{Procedimiento}}. ' +
      'Longitud de trabajo: {{Longitud de trabajo}}. Irrigación con ' +
      '{{Irrigación}}. Medicación intraconducto / obturación: {{Obturación}}. ' +
      'Restauración provisional con {{Provisional}}.',
    prompts: [
      { label: 'Diente', type: 'TEXT', options: [], defaultValue: null },
      {
        label: 'Sesión',
        type: 'ONE',
        options: ['1', '2', '3'],
        defaultValue: '1',
      },
      {
        label: 'Anestesia',
        type: 'ONE',
        options: [
          'Lidocaína 2 % con epinefrina',
          'Mepivacaína 3 %',
          'Articaína 4 %',
          'Sin anestesia',
        ],
        defaultValue: 'Lidocaína 2 % con epinefrina',
      },
      {
        label: 'Procedimiento',
        type: 'MULTI',
        options: [
          'Apertura cameral',
          'Localización de conductos',
          'Conductometría',
          'Instrumentación',
          'Obturación',
        ],
        defaultValue: null,
      },
      {
        label: 'Longitud de trabajo',
        type: 'TEXT',
        options: [],
        defaultValue: null,
      },
      {
        label: 'Irrigación',
        type: 'MULTI',
        options: [
          'Hipoclorito de sodio',
          'EDTA',
          'Clorhexidina',
          'Suero fisiológico',
        ],
        defaultValue: 'Hipoclorito de sodio',
      },
      {
        label: 'Obturación',
        type: 'ONE',
        options: [
          'Hidróxido de calcio',
          'Gutapercha y cemento sellador',
          'Ninguna',
        ],
        defaultValue: null,
      },
      {
        label: 'Provisional',
        type: 'ONE',
        options: ['Cavit', 'Ionómero de vidrio', 'IRM'],
        defaultValue: 'Cavit',
      },
    ],
  },
  {
    name: 'Control postoperatorio',
    category: 'Cirugía',
    body:
      'Control postoperatorio a los {{Días}} días. Dolor: {{Dolor}}. ' +
      'Inflamación: {{Inflamación}}. Cicatrización: {{Cicatrización}}. ' +
      'Retiro de sutura: {{Retiro de sutura}}. Observaciones: {{Observaciones}}.',
    prompts: [
      {
        label: 'Días',
        type: 'ONE',
        options: ['3', '7', '10', '15'],
        defaultValue: '7',
      },
      {
        label: 'Dolor',
        type: 'ONE',
        options: ['Ausente', 'Leve', 'Moderado', 'Intenso'],
        defaultValue: 'Ausente',
      },
      {
        label: 'Inflamación',
        type: 'ONE',
        options: ['Ausente', 'Leve', 'Moderada', 'Marcada'],
        defaultValue: 'Ausente',
      },
      {
        label: 'Cicatrización',
        type: 'ONE',
        options: ['Adecuada', 'Retardada', 'Alveolitis'],
        defaultValue: 'Adecuada',
      },
      {
        label: 'Retiro de sutura',
        type: 'ONE',
        options: ['Sí', 'No', 'No aplica'],
        defaultValue: 'No aplica',
      },
      {
        label: 'Observaciones',
        type: 'TEXT',
        options: [],
        defaultValue: 'Sin complicaciones',
      },
    ],
  },
];
