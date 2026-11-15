import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * DX-111 (BE-006): los mensajes que la API manda a la pantalla están en
 * español. La guarda recorre `src/` (sin specs ni `__fixtures__`) y falla si
 * encuentra un texto en inglés:
 *
 * - en el primer argumento literal de `new XxxException('…')`;
 * - en un `message: '…'` dentro de una excepción (`new XxxException({ … })`)
 *   o de las opciones de un decorador de class-validator en un DTO.
 *
 * Los `new Error('…')` internos no cuentan: acaban en el 500 genérico y su
 * texto nunca sale. Los mensajes por defecto de class-validator y de Nest los
 * traducen la exceptionFactory y el filtro global (DX-111).
 *
 * «Inglés» = más palabras inglesas que españolas y ninguna tilde (la
 * autoprueba fija los casos).
 */
const SRC = join(__dirname, '..');

const ENGLISH = new Set(
  (
    'the an is are be been was were must should not found cannot can could ' +
    'invalid already required only of to in for with missing unknown does do ' +
    'belong unsupported you your empty failed internal request denied ' +
    'forbidden unauthorized allowed exist exists value valid number string ' +
    'array greater less than match each too many insufficient role token ' +
    'after before or and on at by from this that has have longer entity large ' +
    'expected blank least characters date email item plan patient user ' +
    'tenant clinic location appointment payment mismatch access deleted ' +
    'inactive own provided need needs use used when it its into out over per ' +
    'same then there these those which while without'
  ).split(' '),
);
const SPANISH = new Set(
  (
    'el la los las un una de del al que y en con por para sin se su sus ya es ' +
    'son está esta este hay debe puede no más como cuando otra otro solo ' +
    'tiene existe encontrado encontrada válido válida o u e ser'
  ).split(' '),
);

export function looksEnglish(text: string): boolean {
  if (/[áéíóúñ¿¡]/i.test(text)) return false;
  const words = text
    .replace(/\$\{[^}]*\}/g, ' ')
    .toLowerCase()
    .match(/[a-z]+/g);
  if (!words) return false;
  const en = words.filter((w) => ENGLISH.has(w)).length;
  const es = words.filter((w) => SPANISH.has(w)).length;
  return en >= 1 && en > es;
}

const STRING = String.raw`(['"\`])((?:\\.|(?!\1)[^\\])*?)\1`;
const EXCEPTION_ARG = new RegExp(
  String.raw`new\s+\w*Exception\(\s*` + STRING,
  'gs',
);
const MESSAGE_PROP = new RegExp(String.raw`\bmessage:\s*` + STRING, 'gs');

export interface EnglishHit {
  line: number;
  text: string;
}

/** Mensajes en inglés de un fichero de código (ver el comentario de arriba). */
export function englishMessages(source: string, isDto: boolean): EnglishHit[] {
  const hits: EnglishHit[] = [];
  const at = (index: number) => source.slice(0, index).split('\n').length;
  for (const m of source.matchAll(EXCEPTION_ARG)) {
    if (looksEnglish(m[2])) hits.push({ line: at(m.index), text: m[2] });
  }
  for (const m of source.matchAll(MESSAGE_PROP)) {
    const before = source.slice(Math.max(0, m.index - 400), m.index);
    const inException = /new\s+\w*Exception\(\s*\{[^}]*$/s.test(before);
    if ((inException || isDto) && looksEnglish(m[2])) {
      hits.push({ line: at(m.index), text: m[2] });
    }
  }
  return hits;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

const isProductionCode = (file: string): boolean =>
  !file.endsWith('.spec.ts') && !file.split(sep).includes('__fixtures__');

describe('mensajes al cliente en español (DX-111, BE-006)', () => {
  it('autoprueba: detecta el inglés y deja pasar el español', () => {
    const code = [
      "throw new NotFoundException('Patient not found');",
      'throw new BadRequestException(`${field} must be a valid date`);',
      "throw new ConflictException({ code: 'X', message: 'Already exists for this plan' });",
      "throw new NotFoundException('Paciente no encontrado');",
      'throw new BadRequestException(`${field} debe ser una fecha válida`);',
      "throw new Error('No tenant in context');",
      'throw new BadRequestException(PATIENT_NOT_FOUND_MESSAGE);',
    ].join('\n');
    expect(englishMessages(code, false).map((h) => h.line)).toEqual([1, 2, 3]);
    expect(
      englishMessages("@IsString({ message: 'name must be a string' })", true),
    ).toHaveLength(1);
    expect(
      englishMessages(
        "@IsString({ message: 'El nombre debe ser texto.' })",
        true,
      ),
    ).toHaveLength(0);
    // Siglas y códigos sin palabras inglesas no cuentan.
    expect(looksEnglish('FDI 11-48')).toBe(false);
  });

  it('ningún mensaje de excepción ni de DTO en inglés en src/', () => {
    const files = tsFiles(SRC).filter(isProductionCode);
    expect(files.length).toBeGreaterThan(500);
    const offenders = files.flatMap((file) =>
      englishMessages(readFileSync(file, 'utf8'), file.endsWith('.dto.ts')).map(
        (h) => `${relative(SRC, file)}:${h.line} ${h.text}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
