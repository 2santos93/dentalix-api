/**
 * Alerta fármaco–alergia de la receta (DX-013). Compara cada principio activo
 * con las alergias de la anamnesis vigente, sin mayúsculas, tildes ni signos.
 *
 * Coincide si:
 *  - uno contiene al otro como palabras completas («ibuprofeno» dentro de
 *    «AINEs (ibuprofeno)»), con al menos 4 letras para no casar «de» o «sal»;
 *  - o los dos son de la misma familia farmacológica de una lista corta y
 *    conservadora (alergia a «penicilina» y se prescribe «amoxicilina»).
 *
 * Es una ayuda, no un vademécum: falsos negativos posibles con nombres
 * comerciales. Por eso la alerta exige confirmación explícita y no se oculta.
 */

export interface AllergyMatch {
  activeIngredient: string;
  allergen: string;
}

const MIN_DIRECT_LENGTH = 4;

/** Raíces por familia; una palabra del texto pertenece si EMPIEZA por la raíz. */
const FAMILIES: readonly (readonly string[])[] = [
  // Penicilinas y betalactámicos de ese grupo.
  [
    'penicilin',
    'amoxicilin',
    'ampicilin',
    'dicloxacilin',
    'oxacilin',
    'piperacilin',
    'betalactam',
  ],
  // AINE.
  [
    'aine',
    'aines',
    'ibuprofen',
    'naproxen',
    'diclofenac',
    'ketorolac',
    'ketoprofen',
    'dexketoprofen',
    'meloxicam',
    'piroxicam',
    'nimesulid',
    'aspirina',
    'acetilsalicil',
    'metamizol',
    'dipirona',
  ],
  // Cefalosporinas.
  ['cefalosporin', 'cefalexin', 'cefadroxil', 'cefuroxim', 'ceftriaxon'],
  // Macrólidos.
  ['macrolid', 'eritromicin', 'azitromicin', 'claritromicin'],
  // Sulfonamidas.
  ['sulfa', 'sulfonamid', 'sulfametoxazol'],
  // Anestésicos locales tipo amida.
  ['lidocain', 'mepivacain', 'articain', 'prilocain', 'bupivacain'],
  // Paracetamol.
  ['paracetamol', 'acetaminofen'],
];

export function normalizeDrugText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function containsWords(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

function directMatch(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= MIN_DIRECT_LENGTH && containsWords(longer, shorter);
}

function familiesOf(text: string): Set<number> {
  const words = text.split(' ');
  const out = new Set<number>();
  FAMILIES.forEach((stems, index) => {
    if (words.some((w) => stems.some((stem) => w.startsWith(stem)))) {
      out.add(index);
    }
  });
  return out;
}

export function findAllergyMatches(
  activeIngredients: readonly string[],
  allergens: readonly string[],
): AllergyMatch[] {
  const matches: AllergyMatch[] = [];
  const seen = new Set<string>();
  const normalizedAllergens = allergens
    .map((allergen) => ({ allergen, norm: normalizeDrugText(allergen) }))
    .filter((a) => a.norm !== '');

  for (const activeIngredient of activeIngredients) {
    const ing = normalizeDrugText(activeIngredient);
    if (ing === '') continue;
    const ingFamilies = familiesOf(ing);
    for (const { allergen, norm } of normalizedAllergens) {
      const key = `${ing}|${norm}`;
      if (seen.has(key)) continue;
      const sameFamily = [...familiesOf(norm)].some((f) => ingFamilies.has(f));
      if (directMatch(ing, norm) || sameFamily) {
        seen.add(key);
        matches.push({ activeIngredient, allergen });
      }
    }
  }
  return matches;
}
