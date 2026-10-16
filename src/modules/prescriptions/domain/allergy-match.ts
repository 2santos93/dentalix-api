/**
 * Alerta fármaco–alergia de la receta (DX-013). Compara cada principio activo
 * con las alergias de la anamnesis vigente, sin mayúsculas, tildes ni signos.
 *
 * Coincide si:
 *  - uno contiene al otro como palabras completas («ibuprofeno» dentro de
 *    «AINEs (ibuprofeno)»), con al menos 4 letras para no casar «de» o «sal»;
 *    desde 5 letras una palabra casa también con su plural o su forma inglesa
 *    («metronidazol» / «metronidazole», «penicilina» / «penicilinas»);
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
/** Desde esta longitud, una palabra casa con su plural o su forma inglesa. */
const MIN_FUZZY_WORD_LENGTH = 5;
const MAX_FUZZY_SUFFIX = 2;

/**
 * Familias farmacológicas. Cada patrón se prueba contra UNA palabra ya
 * normalizada; los sufijos (`cilin`, `profen`, `floxacin`…) cubren los
 * miembros de la familia que no están en la lista (bencilpenicilina,
 * cloxacilina, cefazolina, aceclofenaco…). Lista conservadora: avisar de más
 * es preferible a callar.
 */
const FAMILIES: readonly (readonly RegExp[])[] = [
  // Penicilinas.
  [/penicil/, /cil{1,2}in/, /^betalactam/],
  // AINE (incluye coxibs, metamizol y salicilatos).
  [
    /^aines?$/,
    /^antiinflamatori/,
    /profen/,
    /^naproxen/,
    /fenac/,
    /xicam/,
    /^ketorolac/,
    /^nimesulid/,
    /^aspirin/,
    /acetilsalicil/,
    /^aas$/,
    /^metamizol/,
    /^dipiron/,
    /coxib/,
  ],
  // Cefalosporinas.
  [/^cef/, /^cephal/],
  // Macrólidos.
  [/^macrolid/, /tromicin/, /thromycin/],
  // Sulfonamidas (no «sulfato»: no es una sulfa).
  [/^sulfas?$/, /^sulfonamid/, /^sulfametox/, /^sulfadiazin/, /^cotrimoxazol/],
  // Anestésicos locales tipo amida (y la alergia genérica a «anestesia»).
  [
    /^anestesi/,
    /^lidocain/,
    /^xilocain/,
    /^mepivacain/,
    /^articain/,
    /^prilocain/,
    /^bupivacain/,
    /^levobupivacain/,
    /^ropivacain/,
  ],
  // Paracetamol.
  [/^paracetamol/, /^acetaminofen/],
  // Quinolonas.
  [/quinolon/, /floxacin/],
  // Tetraciclinas.
  [/ciclin/, /cyclin/],
  // Lincosamidas.
  [/^lincosamid/, /^clindami/, /^lincomi/],
  // Nitroimidazoles.
  [/nidazol/],
];

export function normalizeDrugText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Igual, o la misma palabra con hasta 2 letras más (plural, «-e» inglesa). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return (
    shorter.length >= MIN_FUZZY_WORD_LENGTH &&
    longer.length - shorter.length <= MAX_FUZZY_SUFFIX &&
    longer.startsWith(shorter)
  );
}

/** `needle` aparece en `haystack` como palabras completas y seguidas. */
function containsWords(haystack: string[], needle: string[]): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((word, j) => sameWord(haystack[i + j], word))) {
      return true;
    }
  }
  return false;
}

function directMatch(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return (
    shorter.length >= MIN_DIRECT_LENGTH &&
    containsWords(longer.split(' '), shorter.split(' '))
  );
}

function familiesOf(text: string): Set<number> {
  const words = text.split(' ');
  const out = new Set<number>();
  FAMILIES.forEach((patterns, index) => {
    if (words.some((w) => patterns.some((pattern) => pattern.test(w)))) {
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
