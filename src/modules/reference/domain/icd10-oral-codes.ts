/**
 * CIE-10 (OPS/OMS, edición en español) del capítulo de la cavidad bucal,
 * glándulas salivales y maxilares (K00–K14) más Z01.2 «Examen odontológico»
 * (DX-212). Solo subcategorías de 4 caracteres: son las que se codifican (una
 * categoría de 3 caracteres con subdivisiones no es un código válido para
 * reportar). Datos de referencia, sin datos personales.
 *
 * El seed (`prisma db seed`) las inserta o actualiza con un upsert por código:
 * es idempotente y nunca borra (un diagnóstico guardado sigue apuntando a su
 * código aunque esta lista cambie).
 */
export interface Icd10CodeSeed {
  code: string;
  labelEs: string;
}

export const ICD10_ORAL_CODES: readonly Icd10CodeSeed[] = [
  // K00 Trastornos del desarrollo y de la erupción de los dientes
  { code: 'K00.0', labelEs: 'Anodoncia' },
  { code: 'K00.1', labelEs: 'Dientes supernumerarios' },
  { code: 'K00.2', labelEs: 'Anomalías del tamaño y de la forma del diente' },
  { code: 'K00.3', labelEs: 'Dientes moteados' },
  { code: 'K00.4', labelEs: 'Alteraciones en la formación dentaria' },
  {
    code: 'K00.5',
    labelEs:
      'Alteraciones hereditarias de la estructura dentaria, no clasificadas en otra parte',
  },
  { code: 'K00.6', labelEs: 'Alteraciones en la erupción dentaria' },
  { code: 'K00.7', labelEs: 'Síndrome de la erupción dentaria' },
  { code: 'K00.8', labelEs: 'Otros trastornos del desarrollo de los dientes' },
  {
    code: 'K00.9',
    labelEs: 'Trastorno del desarrollo de los dientes, no especificado',
  },
  // K01 Dientes incluidos e impactados
  { code: 'K01.0', labelEs: 'Dientes incluidos' },
  { code: 'K01.1', labelEs: 'Dientes impactados' },
  // K02 Caries dental
  { code: 'K02.0', labelEs: 'Caries limitada al esmalte' },
  { code: 'K02.1', labelEs: 'Caries de la dentina' },
  { code: 'K02.2', labelEs: 'Caries del cemento' },
  { code: 'K02.3', labelEs: 'Caries dentaria detenida' },
  { code: 'K02.4', labelEs: 'Odontoclasia' },
  { code: 'K02.5', labelEs: 'Caries con exposición pulpar' },
  { code: 'K02.8', labelEs: 'Otras caries dentales' },
  { code: 'K02.9', labelEs: 'Caries dental, no especificada' },
  // K03 Otras enfermedades de los tejidos duros de los dientes
  { code: 'K03.0', labelEs: 'Atrición excesiva de los dientes' },
  { code: 'K03.1', labelEs: 'Abrasión de los dientes' },
  { code: 'K03.2', labelEs: 'Erosión de los dientes' },
  { code: 'K03.3', labelEs: 'Reabsorción patológica de los dientes' },
  { code: 'K03.4', labelEs: 'Hipercementosis' },
  { code: 'K03.5', labelEs: 'Anquilosis dental' },
  { code: 'K03.6', labelEs: 'Depósitos [acreciones] en los dientes' },
  {
    code: 'K03.7',
    labelEs: 'Cambios posteruptivos del color de los tejidos dentales duros',
  },
  {
    code: 'K03.8',
    labelEs:
      'Otras enfermedades especificadas de los tejidos duros de los dientes',
  },
  {
    code: 'K03.9',
    labelEs: 'Enfermedad no especificada de los tejidos duros de los dientes',
  },
  // K04 Enfermedades de la pulpa y de los tejidos periapicales
  { code: 'K04.0', labelEs: 'Pulpitis' },
  { code: 'K04.1', labelEs: 'Necrosis de la pulpa' },
  { code: 'K04.2', labelEs: 'Degeneración de la pulpa' },
  { code: 'K04.3', labelEs: 'Formación anormal de tejido duro en la pulpa' },
  {
    code: 'K04.4',
    labelEs: 'Periodontitis apical aguda originada en la pulpa',
  },
  { code: 'K04.5', labelEs: 'Periodontitis apical crónica' },
  { code: 'K04.6', labelEs: 'Absceso periapical con fístula' },
  { code: 'K04.7', labelEs: 'Absceso periapical sin fístula' },
  { code: 'K04.8', labelEs: 'Quiste radicular' },
  {
    code: 'K04.9',
    labelEs:
      'Otras enfermedades y las no especificadas de la pulpa y del tejido periapical',
  },
  // K05 Gingivitis y enfermedades periodontales
  { code: 'K05.0', labelEs: 'Gingivitis aguda' },
  { code: 'K05.1', labelEs: 'Gingivitis crónica' },
  { code: 'K05.2', labelEs: 'Periodontitis aguda' },
  { code: 'K05.3', labelEs: 'Periodontitis crónica' },
  { code: 'K05.4', labelEs: 'Periodontosis' },
  { code: 'K05.5', labelEs: 'Otras enfermedades periodontales' },
  { code: 'K05.6', labelEs: 'Enfermedad del periodonto, no especificada' },
  // K06 Otros trastornos de la encía y de la zona edéntula
  { code: 'K06.0', labelEs: 'Retracción gingival' },
  { code: 'K06.1', labelEs: 'Hiperplasia gingival' },
  {
    code: 'K06.2',
    labelEs:
      'Lesiones de la encía y de la zona edéntula asociadas con traumatismo',
  },
  {
    code: 'K06.8',
    labelEs: 'Otros trastornos especificados de la encía y de la zona edéntula',
  },
  {
    code: 'K06.9',
    labelEs: 'Trastorno no especificado de la encía y de la zona edéntula',
  },
  // K07 Anomalías dentofaciales [incluso la maloclusión]
  { code: 'K07.0', labelEs: 'Anomalías evidentes del tamaño de los maxilares' },
  { code: 'K07.1', labelEs: 'Anomalías de la relación maxilobasilar' },
  {
    code: 'K07.2',
    labelEs: 'Anomalías de la relación entre los arcos dentarios',
  },
  { code: 'K07.3', labelEs: 'Anomalías de la posición del diente' },
  { code: 'K07.4', labelEs: 'Maloclusión de tipo no especificado' },
  { code: 'K07.5', labelEs: 'Anomalías dentofaciales funcionales' },
  { code: 'K07.6', labelEs: 'Trastornos de la articulación temporomaxilar' },
  { code: 'K07.8', labelEs: 'Otras anomalías dentofaciales' },
  { code: 'K07.9', labelEs: 'Anomalía dentofacial, no especificada' },
  // K08 Otros trastornos de los dientes y de sus estructuras de sostén
  {
    code: 'K08.0',
    labelEs: 'Exfoliación de los dientes debida a causas sistémicas',
  },
  {
    code: 'K08.1',
    labelEs:
      'Pérdida de dientes debida a accidente, extracción o enfermedad periodontal local',
  },
  { code: 'K08.2', labelEs: 'Atrofia del reborde alveolar desdentado' },
  { code: 'K08.3', labelEs: 'Raíz dental retenida' },
  {
    code: 'K08.8',
    labelEs:
      'Otras afecciones especificadas de los dientes y de sus estructuras de sostén',
  },
  {
    code: 'K08.9',
    labelEs:
      'Trastorno de los dientes y de sus estructuras de sostén, no especificado',
  },
  // K09 Quistes de la región bucal, no clasificados en otra parte
  {
    code: 'K09.0',
    labelEs: 'Quistes originados por el desarrollo de los dientes',
  },
  {
    code: 'K09.1',
    labelEs: 'Quistes de las fisuras (no odontogénicos) de la región bucal',
  },
  { code: 'K09.2', labelEs: 'Otros quistes de los maxilares' },
  {
    code: 'K09.8',
    labelEs: 'Otros quistes de la región bucal, no clasificados en otra parte',
  },
  {
    code: 'K09.9',
    labelEs: 'Quiste de la región bucal, sin otra especificación',
  },
  // K10 Otras enfermedades de los maxilares
  { code: 'K10.0', labelEs: 'Trastornos del desarrollo de los maxilares' },
  { code: 'K10.1', labelEs: 'Granuloma central de células gigantes' },
  { code: 'K10.2', labelEs: 'Afecciones inflamatorias de los maxilares' },
  { code: 'K10.3', labelEs: 'Alveolitis del maxilar' },
  {
    code: 'K10.8',
    labelEs: 'Otras enfermedades especificadas de los maxilares',
  },
  { code: 'K10.9', labelEs: 'Enfermedad de los maxilares, no especificada' },
  // K11 Enfermedades de las glándulas salivales
  { code: 'K11.0', labelEs: 'Atrofia de glándula salival' },
  { code: 'K11.1', labelEs: 'Hipertrofia de glándula salival' },
  { code: 'K11.2', labelEs: 'Sialadenitis' },
  { code: 'K11.3', labelEs: 'Absceso de glándula salival' },
  { code: 'K11.4', labelEs: 'Fístula de glándula salival' },
  { code: 'K11.5', labelEs: 'Sialolitiasis' },
  { code: 'K11.6', labelEs: 'Mucocele de glándula salival' },
  { code: 'K11.7', labelEs: 'Alteraciones de la secreción salival' },
  { code: 'K11.8', labelEs: 'Otras enfermedades de las glándulas salivales' },
  { code: 'K11.9', labelEs: 'Enfermedad de glándula salival, no especificada' },
  // K12 Estomatitis y lesiones afines
  { code: 'K12.0', labelEs: 'Estomatitis aftosa recurrente' },
  { code: 'K12.1', labelEs: 'Otras formas de estomatitis' },
  { code: 'K12.2', labelEs: 'Celulitis y absceso de boca' },
  { code: 'K12.3', labelEs: 'Mucositis oral (ulcerativa)' },
  // K13 Otras enfermedades de los labios y de la mucosa bucal
  { code: 'K13.0', labelEs: 'Enfermedades de los labios' },
  { code: 'K13.1', labelEs: 'Mordedura del labio y de la mejilla' },
  {
    code: 'K13.2',
    labelEs:
      'Leucoplasia y otras alteraciones del epitelio bucal, incluyendo la lengua',
  },
  { code: 'K13.3', labelEs: 'Leucoplasia pilosa' },
  {
    code: 'K13.4',
    labelEs: 'Granuloma y lesiones semejantes de la mucosa bucal',
  },
  { code: 'K13.5', labelEs: 'Fibrosis de la submucosa bucal' },
  { code: 'K13.6', labelEs: 'Hiperplasia irritativa de la mucosa bucal' },
  {
    code: 'K13.7',
    labelEs: 'Otras lesiones y las no especificadas de la mucosa bucal',
  },
  // K14 Enfermedades de la lengua
  { code: 'K14.0', labelEs: 'Glositis' },
  { code: 'K14.1', labelEs: 'Lengua geográfica' },
  { code: 'K14.2', labelEs: 'Glositis romboidea mediana' },
  { code: 'K14.3', labelEs: 'Hipertrofia de las papilas linguales' },
  { code: 'K14.4', labelEs: 'Atrofia de las papilas linguales' },
  { code: 'K14.5', labelEs: 'Lengua plegada' },
  { code: 'K14.6', labelEs: 'Glosodinia' },
  { code: 'K14.8', labelEs: 'Otras enfermedades de la lengua' },
  { code: 'K14.9', labelEs: 'Enfermedad de la lengua, no especificada' },
  // Z01.2 Examen odontológico (consulta de control sin hallazgos)
  { code: 'Z01.2', labelEs: 'Examen odontológico' },
];
