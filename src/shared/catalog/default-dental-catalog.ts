import { CatalogKind } from '@prisma/client';

// Catálogo semilla de procedimientos y diagnósticos odontológicos. Es la fuente
// ÚNICA de verdad: la usa tanto el alta de una clínica nueva (createClinicWithOwner)
// como el backfill idempotente de `prisma/seed.ts`. Vive en `shared/` para que el
// módulo `auth` pueda importarla sin depender del módulo `dental-catalog`.
//
// `defaultPrice` se deja en null a propósito: cada clínica define sus tarifas
// editando el ítem. `active` toma el default `true` del schema. `code` es único
// por tenant (@@unique([tenantId, code])) y usa un prefijo por categoría.

export interface DefaultCatalogItem {
  code: string;
  category: string;
  kind: CatalogKind;
  labelEs: string;
  labelEn: string;
  labelPt: string;
  color: string; // hex #RRGGBB
}

// [code, labelEs, labelEn, labelPt] — category/kind/color vienen del grupo.
type Row = readonly [string, string, string, string];

function group(
  category: string,
  kind: CatalogKind,
  color: string,
  rows: readonly Row[],
): DefaultCatalogItem[] {
  return rows.map(([code, labelEs, labelEn, labelPt]) => ({
    code,
    category,
    kind,
    labelEs,
    labelEn,
    labelPt,
    color,
  }));
}

// Diagnósticos: color por ítem (paleta de patología), no por categoría.
const DIAGNOSES: DefaultCatalogItem[] = (
  [
    ['DX-CARIES', 'Caries dental', 'Dental caries', 'Cárie dentária', '#BE123C'],
    ['DX-CARIES-INC', 'Caries incipiente', 'Incipient caries', 'Cárie incipiente', '#F97316'],
    ['DX-REST-DEF', 'Restauración defectuosa', 'Defective restoration', 'Restauração defeituosa', '#A16207'],
    ['DX-FRACT', 'Fractura dental', 'Tooth fracture', 'Fratura dentária', '#7C2D12'],
    ['DX-PERIAPICAL', 'Lesión periapical', 'Periapical lesion', 'Lesão periapical', '#9333EA'],
    ['DX-ABSCESO', 'Absceso dental', 'Dental abscess', 'Abscesso dentário', '#7E22CE'],
    ['DX-MOVILIDAD', 'Movilidad dental', 'Tooth mobility', 'Mobilidade dentária', '#DB2777'],
    ['DX-AUSENTE', 'Diente ausente', 'Missing tooth', 'Dente ausente', '#6B7280'],
    ['DX-RETENIDO', 'Diente retenido/incluido', 'Impacted tooth', 'Dente retido', '#4B5563'],
    ['DX-RESTO-RAD', 'Resto radicular', 'Root remnant', 'Resto radicular', '#78716C'],
    ['DX-GINGIVITIS', 'Gingivitis', 'Gingivitis', 'Gengivite', '#EF4444'],
    ['DX-PERIODONTITIS', 'Periodontitis', 'Periodontitis', 'Periodontite', '#B91C1C'],
    ['DX-RECESION', 'Recesión gingival', 'Gingival recession', 'Recessão gengival', '#E11D48'],
    ['DX-CALCULO', 'Cálculo / sarro', 'Calculus (tartar)', 'Cálculo (tártaro)', '#CA8A04'],
    ['DX-DESGASTE', 'Desgaste dental', 'Tooth wear', 'Desgaste dentário', '#92400E'],
    ['DX-SENSIBILIDAD', 'Sensibilidad dentinaria', 'Dentin sensitivity', 'Sensibilidade dentinária', '#0891B2'],
    ['DX-MALOCLUSION', 'Maloclusión', 'Malocclusion', 'Má oclusão', '#7C3AED'],
    ['DX-PIGMENTACION', 'Pigmentación dental', 'Tooth discoloration', 'Pigmentação dentária', '#57534E'],
    ['DX-ERUPCION', 'Diente en erupción', 'Erupting tooth', 'Dente em erupção', '#16A34A'],
  ] as const
).map(([code, labelEs, labelEn, labelPt, color]) => ({
  code,
  category: 'Diagnóstico',
  kind: CatalogKind.DIAGNOSIS,
  labelEs,
  labelEn,
  labelPt,
  color,
}));

const P = CatalogKind.PROCEDURE;

export const DEFAULT_DENTAL_CATALOG: DefaultCatalogItem[] = [
  ...DIAGNOSES,

  ...group('Diagnóstico e imágenes', P, '#0E7490', [
    ['IMG-CONSULTA', 'Consulta y valoración', 'Consultation & exam', 'Consulta e avaliação'],
    ['IMG-RX-PERIAPICAL', 'Radiografía periapical', 'Periapical X-ray', 'Radiografia periapical'],
    ['IMG-RX-PANORAMICA', 'Radiografía panorámica', 'Panoramic X-ray', 'Radiografia panorâmica'],
    ['IMG-RX-BITEWING', 'Radiografía de aleta mordida', 'Bitewing X-ray', 'Radiografia interproximal'],
    ['IMG-RX-OCLUSAL', 'Radiografía oclusal', 'Occlusal X-ray', 'Radiografia oclusal'],
    ['IMG-CBCT', 'Tomografía (CBCT)', 'CBCT scan', 'Tomografia (TCFC)'],
    ['IMG-MODELOS', 'Modelos de estudio', 'Study models', 'Modelos de estudo'],
    ['IMG-FOTOS', 'Fotografías clínicas', 'Clinical photographs', 'Fotografias clínicas'],
  ]),

  ...group('Prevención', P, '#16A34A', [
    ['PREV-PROFILAXIS', 'Profilaxis (limpieza dental)', 'Prophylaxis (cleaning)', 'Profilaxia (limpeza)'],
    ['PREV-FLUOR', 'Aplicación de flúor', 'Fluoride application', 'Aplicação de flúor'],
    ['PREV-SELLANTE', 'Sellante de fosas y fisuras', 'Pit & fissure sealant', 'Selante de fóssulas e fissuras'],
    ['PREV-HIGIENE', 'Instrucción de higiene oral', 'Oral hygiene instruction', 'Instrução de higiene oral'],
  ]),

  ...group('Operatoria', P, '#2563EB', [
    ['OP-RESINA-1', 'Resina 1 superficie', 'Composite filling (1 surface)', 'Restauração em resina (1 face)'],
    ['OP-RESINA-2', 'Resina 2 superficies', 'Composite filling (2 surfaces)', 'Resina (2 faces)'],
    ['OP-RESINA-3', 'Resina 3+ superficies', 'Composite filling (3+ surfaces)', 'Resina (3+ faces)'],
    ['OP-INCRUSTACION', 'Incrustación (inlay/onlay)', 'Inlay / onlay', 'Incrustação (inlay/onlay)'],
    ['OP-POSTE', 'Reconstrucción con poste', 'Post & core buildup', 'Reconstrução com pino'],
    ['OP-RECUB-PULPAR', 'Recubrimiento pulpar', 'Pulp capping', 'Capeamento pulpar'],
  ]),

  ...group('Endodoncia', P, '#DC2626', [
    ['ENDO-UNI', 'Endodoncia unirradicular', 'Root canal (single canal)', 'Endodontia unirradicular'],
    ['ENDO-BI', 'Endodoncia birradicular', 'Root canal (two canals)', 'Endodontia birradicular'],
    ['ENDO-MULTI', 'Endodoncia multirradicular (molar)', 'Root canal (molar)', 'Endodontia multirradicular'],
    ['ENDO-RETRAT', 'Retratamiento endodóntico', 'Endodontic retreatment', 'Retratamento endodôntico'],
    ['ENDO-PULPOTOMIA', 'Pulpotomía', 'Pulpotomy', 'Pulpotomia'],
    ['ENDO-PULPECTOMIA', 'Pulpectomía', 'Pulpectomy', 'Pulpectomia'],
    ['ENDO-BLANQ-INT', 'Blanqueamiento interno', 'Internal bleaching', 'Clareamento interno'],
  ]),

  ...group('Periodoncia', P, '#DB2777', [
    ['PERIO-RASPADO', 'Raspado y alisado radicular (por cuadrante)', 'Scaling & root planing (per quadrant)', 'Raspagem e alisamento radicular (por quadrante)'],
    ['PERIO-CURETAJE', 'Curetaje periodontal', 'Periodontal curettage', 'Curetagem periodontal'],
    ['PERIO-COLGAJO', 'Cirugía de colgajo periodontal', 'Periodontal flap surgery', 'Cirurgia de retalho periodontal'],
    ['PERIO-GINGIVECTOMIA', 'Gingivectomía', 'Gingivectomy', 'Gengivectomia'],
    ['PERIO-INJERTO-GING', 'Injerto gingival', 'Gingival graft', 'Enxerto gengival'],
    ['PERIO-ALARGAMIENTO', 'Alargamiento de corona', 'Crown lengthening', 'Aumento de coroa clínica'],
    ['PERIO-MANTENIMIENTO', 'Mantenimiento periodontal', 'Periodontal maintenance', 'Manutenção periodontal'],
  ]),

  ...group('Cirugía oral', P, '#7C3AED', [
    ['CX-EXO-SIMPLE', 'Exodoncia simple', 'Simple extraction', 'Exodontia simples'],
    ['CX-EXO-QUIRURGICA', 'Exodoncia quirúrgica', 'Surgical extraction', 'Exodontia cirúrgica'],
    ['CX-CORDAL-ERUP', 'Extracción de cordal erupcionado', 'Erupted third molar extraction', 'Extração de siso irrompido'],
    ['CX-CORDAL-INCL', 'Extracción de cordal incluido', 'Impacted third molar extraction', 'Extração de siso incluso'],
    ['CX-FRENILLECTOMIA', 'Frenillectomía', 'Frenectomy', 'Frenectomia'],
    ['CX-BIOPSIA', 'Biopsia oral', 'Oral biopsy', 'Biópsia oral'],
    ['CX-DRENAJE', 'Drenaje de absceso', 'Abscess drainage', 'Drenagem de abscesso'],
    ['CX-ALVEOLOPLASTIA', 'Alveoloplastia', 'Alveoloplasty', 'Alveoloplastia'],
    ['CX-APICECTOMIA', 'Apicectomía', 'Apicoectomy', 'Apicectomia'],
  ]),

  ...group('Prótesis', P, '#CA8A04', [
    ['PROT-CORONA-MP', 'Corona metal-porcelana', 'Porcelain-fused-to-metal crown', 'Coroa metalocerâmica'],
    ['PROT-CORONA-LM', 'Corona libre de metal', 'All-ceramic crown', 'Coroa livre de metal'],
    ['PROT-CORONA-PROV', 'Corona provisional', 'Provisional crown', 'Coroa provisória'],
    ['PROT-PPR-ACRILICA', 'Prótesis parcial removible acrílica', 'Acrylic removable partial denture', 'Prótese parcial removível acrílica'],
    ['PROT-PPR-METALICA', 'Prótesis parcial removible metálica', 'Cast metal partial denture', 'Prótese parcial removível metálica'],
    ['PROT-TOTAL', 'Prótesis total (dentadura completa)', 'Complete denture', 'Prótese total'],
    ['PROT-PUENTE', 'Puente fijo (por unidad)', 'Fixed bridge (per unit)', 'Ponte fixa (por elemento)'],
    ['PROT-POSTE-MUNON', 'Poste y muñón', 'Post & core', 'Núcleo (pino e coto)'],
    ['PROT-REPARACION', 'Reparación de prótesis', 'Denture repair', 'Reparo de prótese'],
    ['PROT-REBASE', 'Rebase de prótesis', 'Denture reline', 'Reembasamento de prótese'],
  ]),

  ...group('Implantología', P, '#0D9488', [
    ['IMPL-IMPLANTE', 'Implante dental', 'Dental implant placement', 'Implante dentário'],
    ['IMPL-CORONA', 'Corona sobre implante', 'Implant-supported crown', 'Coroa sobre implante'],
    ['IMPL-INJERTO-OSEO', 'Injerto óseo', 'Bone graft', 'Enxerto ósseo'],
    ['IMPL-ELEV-SENO', 'Elevación de seno maxilar', 'Sinus lift', 'Levantamento de seio maxilar'],
    ['IMPL-PILAR', 'Pilar / aditamento', 'Implant abutment', 'Pilar (abutment)'],
  ]),

  ...group('Ortodoncia', P, '#9333EA', [
    ['ORTO-VALORACION', 'Valoración ortodóntica', 'Orthodontic assessment', 'Avaliação ortodôntica'],
    ['ORTO-BRACKETS-MET', 'Ortodoncia con brackets metálicos', 'Metal braces', 'Aparelho fixo metálico'],
    ['ORTO-BRACKETS-EST', 'Ortodoncia con brackets estéticos', 'Ceramic braces', 'Aparelho estético'],
    ['ORTO-ALINEADORES', 'Ortodoncia con alineadores', 'Clear aligners', 'Alinhadores'],
    ['ORTO-CONTROL', 'Control / ajuste mensual', 'Monthly adjustment', 'Ajuste mensal'],
    ['ORTO-RETENEDOR', 'Retenedores', 'Retainers', 'Contenções'],
    ['ORTO-ORTOPEDIA', 'Aparatología ortopédica funcional', 'Functional/orthopedic appliance', 'Aparelho ortopédico funcional'],
  ]),

  ...group('Odontopediatría', P, '#F59E0B', [
    ['PED-CONSULTA', 'Consulta odontopediátrica', 'Pediatric consultation', 'Consulta odontopediátrica'],
    ['PED-PROFILAXIS', 'Profilaxis pediátrica', 'Pediatric prophylaxis', 'Profilaxia pediátrica'],
    ['PED-FLUOR', 'Aplicación de flúor pediátrico', 'Pediatric fluoride', 'Flúor pediátrico'],
    ['PED-SELLANTE', 'Sellante pediátrico', 'Pediatric sealant', 'Selante pediátrico'],
    ['PED-CORONA-ACERO', 'Corona de acero pediátrica', 'Stainless steel crown', 'Coroa de aço pediátrica'],
    ['PED-PULPOTOMIA', 'Pulpotomía pediátrica', 'Pediatric pulpotomy', 'Pulpotomia pediátrica'],
    ['PED-MANTENEDOR', 'Mantenedor de espacio', 'Space maintainer', 'Mantenedor de espaço'],
  ]),

  ...group('Estética', P, '#06B6D4', [
    ['EST-BLANQ-CONSULTORIO', 'Blanqueamiento en consultorio', 'In-office whitening', 'Clareamento em consultório'],
    ['EST-BLANQ-CASA', 'Blanqueamiento ambulatorio (casa)', 'Take-home whitening', 'Clareamento caseiro'],
    ['EST-CARILLA-RESINA', 'Carilla de resina', 'Composite veneer', 'Faceta em resina'],
    ['EST-CARILLA-PORCELANA', 'Carilla de porcelana', 'Porcelain veneer', 'Faceta de porcelana'],
    ['EST-DISENO-SONRISA', 'Diseño de sonrisa', 'Smile design', 'Planejamento de sorriso'],
  ]),

  ...group('Urgencias', P, '#EA580C', [
    ['URG-CONSULTA', 'Consulta de urgencia', 'Emergency visit', 'Consulta de urgência'],
    ['URG-DOLOR', 'Manejo del dolor', 'Pain management', 'Controle da dor'],
    ['URG-RECEMENTADO', 'Recementado de corona/puente', 'Crown/bridge re-cementation', 'Recimentação de coroa/ponte'],
  ]),
];
