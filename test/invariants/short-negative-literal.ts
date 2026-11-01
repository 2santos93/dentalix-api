import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { SpecSource } from './bare-delete-many';

// DX-496 (TST-059): un assert negativo de texto (`not.toContain`,
// `not.toMatch`, `expect.not.stringContaining/stringMatching`) con un literal
// corto de cifras o hex sobre un texto que lleva UUID u horas falla al azar:
// cada posición de un UUID coincide con 3 cifras con p ≈ 1/4096 y los
// milisegundos con p = 1/1000. Con 6 caracteres o más la probabilidad por
// posición baja a 16⁻⁶ ≈ 6·10⁻⁸ y deja de ser un flaky.

/** Este fichero y su spec llevan el patrón como ejemplo, dentro de cadenas. */
const SELF = new Set([
  'test/invariants/short-negative-literal.ts',
  'test/invariants/short-negative-literal.spec.ts',
]);

export const MIN_SENTINEL_LENGTH = 6;

export interface ShortNegativeLiteral {
  path: string;
  line: number;
  matcher: string;
  literal: string;
}

/** Cifras o hex (con separadores `.:,-`), con al menos una cifra y corto. */
export function isShortNumeric(literal: string): boolean {
  return (
    literal.length < MIN_SENTINEL_LENGTH &&
    /^[0-9a-f.:,-]+$/i.test(literal) &&
    /\d/.test(literal)
  );
}

const NEGATIVE =
  /(?:\.\s*not\s*\.\s*(toContain|toMatch)|\bexpect\s*\.\s*not\s*\.\s*(stringContaining|stringMatching))\s*\(\s*/g;

/** El argumento del matcher, hasta su `)` (sin paréntesis anidados raros). */
const ARGUMENT =
  /^(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`$\\]*)`|\/((?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+)\/[a-z]*|(\d+(?:\.\d+)?)|String\(\s*([A-Za-z_$][\w$]*)\s*\)|`\$\{\s*([A-Za-z_$][\w$]*)\s*\}`|([A-Za-z_$][\w$]*)(?:\.toString\(\))?)\s*,?\s*\)/;

const IDENT = /^[A-Za-z_$][\w$]*$/;
const LITERAL =
  /^(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`$\\]*)`|(\d+(?:\.\d+)?))$/;

/** Una variable del fichero: su posición y los valores que puede tomar. */
interface Binding {
  name: string;
  index: number;
  /** Literales que puede tomar. */
  values: string[];
  /** Nombres de otras variables de la lista (se resuelven al usarlas). */
  refs: string[];
}

/** El texto de un literal de cadena o número, o null si no lo es. */
function literalText(expr: string): string | null {
  const m = LITERAL.exec(expr.trim());
  return m ? (m[1] ?? m[2] ?? m[3] ?? m[4]) : null;
}

/** Los elementos de una lista literal, separados por las comas de primer nivel. */
function arrayElements(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      current += c;
      if (c === '\\') current += body[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) out.push(current);
  return out.map((e) => e.trim()).filter((e) => e.length > 0);
}

/**
 * `const NOMBRE = <literal>` y `for (const NOMBRE of [<lista literal>])` del
 * fichero. De la lista solo cuentan los elementos que son un literal o el
 * nombre de otra variable; una expresión (`NUMBER.slice(0, -4)`) no se evalúa.
 */
function bindings(source: string): Binding[] {
  const out: Binding[] = [];
  const decl =
    /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w.]+\s*)?=\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`[^`$\\]*`|\d+(?:\.\d+)?)\s*(?:as\s+const\s*)?;/g;
  for (const m of source.matchAll(decl)) {
    out.push({
      name: m[1],
      index: m.index,
      values: [literalText(m[2]) ?? ''],
      refs: [],
    });
  }
  const loop = /\bfor\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+\[/g;
  for (const m of source.matchAll(loop)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '[') depth++;
      else if (source[i] === ']' && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) continue;
    const values: string[] = [];
    const refs: string[] = [];
    for (const element of arrayElements(source.slice(open + 1, close))) {
      const text = literalText(element);
      if (text !== null) values.push(text);
      else if (IDENT.test(element)) refs.push(element);
    }
    out.push({ name: m[1], index: m.index, values, refs });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Valores posibles de `name` en `index`: la última declaración anterior con
 * ese nombre (un `leaked` de otro bucle más arriba no cuenta).
 */
function resolve(
  all: Binding[],
  name: string,
  index: number,
  seen = new Set<string>(),
): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const binding = all.filter((b) => b.name === name && b.index < index).pop();
  if (!binding) return [];
  return [
    ...binding.values,
    ...binding.refs.flatMap((ref) => resolve(all, ref, binding.index, seen)),
  ];
}

/**
 * Ramas literales de una regex: `/6c1d|ana/` → `6c1d`, `ana`. Sin anclas,
 * grupos ni `\b`, así `/(204|146)/` o `/^204$/` no se escapan.
 */
function regexLiterals(pattern: string): string[] {
  return pattern
    .split(/(?<!\\)\|/)
    .map((branch) =>
      branch.replace(/\\b|\(\?:|(?<!\\)[\^$()]/g, '').replace(/\\\./g, '.'),
    )
    .filter((branch) => /^[\w.:,-]*$/.test(branch));
}

/**
 * El sujeto de `expect(…)` que precede a `.not` empieza en `index`; devuelve
 * su texto, o null si no se encuentra.
 */
function subjectBefore(source: string, index: number): string | null {
  let i = index - 1;
  while (i >= 0 && /\s/.test(source[i])) i--;
  if (source[i] !== ')') return null;
  let depth = 0;
  for (let j = i; j >= 0; j--) {
    if (source[j] === ')') depth++;
    else if (source[j] === '(') {
      depth--;
      if (depth === 0) {
        const head = source.slice(Math.max(0, j - 6), j);
        return head.endsWith('expect') ? source.slice(j + 1, i) : null;
      }
    }
  }
  return null;
}

/** Lo que llama la última llamada del texto: `a.map((x) => f(x))` → `a.map`. */
function trailingCallee(s: string): string | null {
  if (!s.endsWith(')')) return null;
  let depth = 0;
  for (let j = s.length - 1; j >= 0; j--) {
    if (s[j] === ')') depth++;
    else if (s[j] === '(' && --depth === 0) return s.slice(0, j);
  }
  return null;
}

/** `toContain` sobre una lista compara elementos enteros, no subcadenas. */
function isArraySubject(subject: string | null): boolean {
  if (subject === null) return false;
  const s = subject.trim();
  if (s.startsWith('[') && s.endsWith(']')) return true;
  const callee = trailingCallee(s);
  return (
    callee !== null &&
    (/^Object\.(keys|values|entries)$/.test(callee) ||
      /\.(map|filter|flatMap)$/.test(callee))
  );
}

export function findShortNegativeLiterals(
  specs: SpecSource[],
): ShortNegativeLiteral[] {
  const found: ShortNegativeLiteral[] = [];
  for (const spec of specs) {
    if (SELF.has(spec.path)) continue;
    const scope = bindings(spec.source);
    for (const m of spec.source.matchAll(NEGATIVE)) {
      const matcher = m[1] ?? m[2];
      const start = m.index + m[0].length;
      const arg = ARGUMENT.exec(spec.source.slice(start));
      if (!arg) continue;
      const [, single, double, template, regex, num, str, tpl, ident] = arg;
      const text = single ?? double ?? template;
      let literals: string[];
      if (regex !== undefined) literals = regexLiterals(regex);
      else if (num !== undefined) literals = [num];
      else if (text !== undefined) literals = [text];
      else {
        const name = str ?? tpl ?? ident;
        literals = name === undefined ? [] : resolve(scope, name, m.index);
      }
      const risky = literals.filter(isShortNumeric);
      if (risky.length === 0) continue;
      if (
        matcher === 'toContain' &&
        isArraySubject(subjectBefore(spec.source, m.index))
      ) {
        continue;
      }
      const line = spec.source.slice(0, m.index).split('\n').length;
      for (const literal of risky) {
        found.push({ path: spec.path, line, matcher, literal });
      }
    }
  }
  return found;
}

export function formatShortNegativeLiterals(
  found: ShortNegativeLiteral[],
): string {
  return found
    .map(
      (f) =>
        `${f.path}:${f.line}: \`not.${f.matcher}('${f.literal}')\` busca un literal corto de cifras/hex: ` +
        `aparece al azar en UUID y horas (TST-059). Comprueba los campos que pueden llevar el dato ` +
        `(leavesWith de test/support/content-leaves.ts, o un toEqual exacto) o usa un centinela ` +
        `de ${MIN_SENTINEL_LENGTH} caracteres o más.`,
    )
    .join('\n');
}

const SPEC_FILE = /(?:\.spec|-spec)\.ts$/;

/** Todos los specs del repo: unit de src/ y test/, e2e, int y owner-spec. */
export function readAllSpecs(repoRoot: string): SpecSource[] {
  const walk = (dir: string): SpecSource[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' ? [] : walk(full);
      }
      if (!SPEC_FILE.test(entry.name)) return [];
      const path = relative(repoRoot, full).split(sep).join('/');
      return [{ path, source: readFileSync(full, 'utf8') }];
    });
  return [...walk(join(repoRoot, 'src')), ...walk(join(repoRoot, 'test'))];
}
