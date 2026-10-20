/**
 * Plantillas de ejemplo de indicaciones postoperatorias (DX-222). Texto breve y
 * sobrio, con las variables de `POSTOP_VARIABLES`. La clínica puede cargarlas
 * como punto de partida y editarlas a su criterio clínico.
 */
export interface SamplePostOpTemplate {
  code: string;
  title: string;
  body: string;
}

const URGENCIAS =
  'Si tienes dolor intenso que no cede, sangrado que no para o fiebre, llama a {{clinica}} al {{telefono_sede}} en horario de atención. Fuera de horario, acude al servicio de urgencias más cercano.';

function body(lines: string[]): string {
  return [...lines, URGENCIAS].join('\n\n');
}

export const SAMPLE_POSTOP_TEMPLATES: ReadonlyArray<SamplePostOpTemplate> = [
  {
    code: 'POI-EXO',
    title: 'Exodoncia simple',
    body: body([
      'Hola {{paciente}}, estas son las indicaciones tras tu extracción dental en {{clinica}}.',
      'Primeras 24 horas: muerde la gasa con firmeza durante 30 a 45 minutos y no la cambies antes de ese tiempo.',
      'No te enjuagues, no escupas con fuerza y no uses pajilla, para no desprender el coágulo.',
      'Aplica frío por fuera de la cara, 15 minutos sí y 15 no, durante las primeras horas.',
      'Come alimentos blandos y fríos o tibios. Evita lo caliente, lo duro y lo picante.',
      'No fumes ni tomes alcohol durante al menos 48 horas.',
      'Desde el día siguiente puedes enjuagarte con suavidad con agua tibia y sal. Cepilla el resto de la boca con cuidado y evita la zona de la extracción.',
      'Toma solo los medicamentos que te indicó tu odontólogo, en la dosis y el horario señalados.',
      'Evita el ejercicio intenso durante 48 horas y duerme con la cabeza un poco elevada.',
    ]),
  },
  {
    code: 'POI-CORDAL',
    title: 'Cordal / exodoncia quirúrgica',
    body: body([
      'Hola {{paciente}}, estas son las indicaciones tras tu cirugía en {{clinica}}.',
      'Muerde la gasa con firmeza durante 45 minutos. Es normal un leve sangrado o saliva con sangre las primeras horas.',
      'Aplica frío por fuera de la cara, 15 minutos sí y 15 no, durante las primeras 24 a 48 horas. La hinchazón suele ser mayor al segundo o tercer día.',
      'No te enjuagues ni escupas con fuerza durante las primeras 24 horas. No uses pajilla.',
      'Come solo alimentos blandos y fríos o tibios durante varios días. Evita lo duro, lo caliente y lo picante.',
      'No fumes ni tomes alcohol durante al menos 72 horas.',
      'Descansa y duerme con la cabeza elevada. Evita el ejercicio intenso durante una semana.',
      'Toma los medicamentos tal como te los indicó tu odontólogo, sin saltarte dosis.',
      'Si te dieron puntos, no los toques con la lengua ni los dedos. Se revisan o retiran en el control.',
    ]),
  },
  {
    code: 'POI-ENDO',
    title: 'Endodoncia',
    body: body([
      'Hola {{paciente}}, estas son las indicaciones tras tu tratamiento de conducto en {{clinica}}.',
      'La anestesia puede durar unas horas. No muerdas ni comas hasta que se pase, para no lastimarte labio o lengua.',
      'Es normal sentir sensibilidad o molestia al masticar durante unos días. Toma el analgésico que te indicó tu odontólogo.',
      'Evita masticar con ese diente alimentos duros o pegajosos hasta que tenga su restauración definitiva.',
      'Si te dejaron una obturación provisional, puede desprenderse con el tiempo. Si pasa, avísanos.',
      'Mantén tu higiene normal, cepillando con suavidad la zona y usando seda dental.',
      'No abandones el tratamiento: la restauración definitiva protege el diente. Asiste a la cita de control.',
    ]),
  },
  {
    code: 'POI-IMPLANTE',
    title: 'Implante',
    body: body([
      'Hola {{paciente}}, estas son las indicaciones tras la colocación de tu implante en {{clinica}}.',
      'Muerde la gasa con firmeza durante 45 minutos. Un leve sangrado las primeras horas es normal.',
      'Aplica frío por fuera de la cara, 15 minutos sí y 15 no, durante las primeras 24 a 48 horas.',
      'Come alimentos blandos y fríos o tibios durante la primera semana. No mastiques sobre la zona del implante.',
      'No fumes ni tomes alcohol: retrasan la cicatrización y ponen en riesgo el implante.',
      'Evita tocar la zona con la lengua o los dedos y no tires del labio para mirarla.',
      'Cepilla el resto de la boca con normalidad. Sobre la zona usa solo el enjuague que te recomendó tu odontólogo.',
      'Toma los medicamentos tal como te los indicó tu odontólogo, sin saltarte dosis.',
      'Evita el ejercicio intenso durante una semana y asiste a todos los controles.',
    ]),
  },
  {
    code: 'POI-PROTESIS',
    title: 'Prótesis inmediata',
    body: body([
      'Hola {{paciente}}, estas son las indicaciones para el uso de tu prótesis inmediata de {{clinica}}.',
      'Mantén la prótesis puesta las primeras 24 horas, salvo que tu odontólogo te indique otra cosa. Ayuda a controlar el sangrado y la hinchazón.',
      'Es normal sentir presión, molestia al hablar y más saliva los primeros días. Poco a poco te acostumbrarás.',
      'Come alimentos blandos y corta la comida en trozos pequeños. Evita lo duro, lo pegajoso y morder con los dientes delanteros.',
      'Después de 24 horas retírala para limpiarla con cepillo suave y jabón neutro. Enjuágate con agua tibia y sal.',
      'Por la noche guárdala en agua limpia, a menos que te hayan indicado dormir con ella.',
      'No la ajustes ni la arregles por tu cuenta. Si te lastima una zona, pide una cita de ajuste.',
      'Asiste a los controles: la encía cambia mientras cicatriza y la prótesis necesitará ajustes.',
    ]),
  },
];
