import { MedicalHistoryVersionData } from './ports/medical-history-repository.port';
import { SafetyFlags } from './entities/medical-history.entity';

// Palabras clave (normalizadas sin tildes/mayúsculas) que elevan una entrada a
// bandera crítica. Listas conservadoras y ampliables; el match es por inclusión.
const ANESTHETIC_KW = [
  'anestes',
  'lidocain',
  'lidocaina',
  'novocain',
  'xilocain',
  'articain',
  'mepivacain',
];
const PENICILLIN_KW = ['penicilin', 'amoxicilin', 'ampicilin', 'betalactam'];
const LATEX_KW = ['latex'];
const ANTICOAGULANT_KW = [
  'warfarin',
  'rivaroxab',
  'apixab',
  'dabigatr',
  'clopidogrel',
  'heparin',
  'acenocumarol',
  'aspirina',
];
const BISPHOSPHONATE_KW = [
  'alendron',
  'zoledron',
  'risedron',
  'ibandron',
  'denosumab',
  'bifosfonat',
];
// Condiciones (por `codigo`) que requieren profilaxis antibiótica.
const PROPHYLAXIS_CODES = new Set([
  'VALVULOPATIA',
  'PROTESIS_VALVULAR',
  'ENDOCARDITIS_PREVIA',
  'REEMPLAZO_ARTICULAR',
  'INMUNOSUPRESION',
]);

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function anyMatch(haystacks: string[], keywords: string[]): boolean {
  return haystacks.some((h) => {
    const n = norm(h);
    return keywords.some((kw) => n.includes(kw));
  });
}

/**
 * Deriva las banderas de seguridad y `hasCriticalAlert` a partir de la entrada
 * estructurada. NUNCA confía en flags provistas por el cliente: siempre
 * recalcula. `embarazo`/`semanasEmbarazo` son la única entrada directa (no se
 * pueden inferir de las listas).
 */
export function deriveSafetyFlags(data: MedicalHistoryVersionData): {
  safetyFlags: SafetyFlags;
  hasCriticalAlert: boolean;
} {
  const allergens = (data.allergies ?? []).map((a) => a.alergeno);
  const meds = (data.medications ?? []).map((m) => m.nombre);
  const conditions = data.conditions ?? [];
  const conditionYes = (codigo: string) =>
    conditions.some((c) => c.codigo === codigo && c.estado === 'SI');

  const safetyFlags: SafetyFlags = {
    embarazo: data.embarazo === true,
    ...(data.embarazo === true && data.semanasEmbarazo !== undefined
      ? { semanasEmbarazo: data.semanasEmbarazo }
      : {}),
    anticoagulantes: anyMatch(meds, ANTICOAGULANT_KW),
    bifosfonatos: anyMatch(meds, BISPHOSPHONATE_KW),
    diabetes: conditionYes('DIABETES'),
    profilaxisAntibiotica: conditions.some(
      (c) => c.estado === 'SI' && PROPHYLAXIS_CODES.has(c.codigo),
    ),
    alergiaAnestesico: anyMatch(allergens, ANESTHETIC_KW),
    alergiaPenicilina: anyMatch(allergens, PENICILLIN_KW),
    alergiaLatex: anyMatch(allergens, LATEX_KW),
  };

  const anyAllergyAlert = (data.allergies ?? []).some((a) => a.esAlerta);
  const anyBooleanFlag =
    safetyFlags.embarazo ||
    safetyFlags.anticoagulantes ||
    safetyFlags.bifosfonatos ||
    safetyFlags.diabetes ||
    safetyFlags.profilaxisAntibiotica ||
    safetyFlags.alergiaAnestesico ||
    safetyFlags.alergiaPenicilina ||
    safetyFlags.alergiaLatex;

  return { safetyFlags, hasCriticalAlert: anyAllergyAlert || anyBooleanFlag };
}
