import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * DX-451 (TST-055): exenciones de la matriz de aislamiento
 * (`test/tenant-isolation-matrix.e2e-spec.ts`) que se verifican solas.
 *
 * Una ruta exenta no se ataca en la matriz porque otro spec ya prueba que la
 * clínica B no lee ni toca el recurso de A por ella. Cada exención dice:
 *  - `spec`: el fichero de `test/` que lo prueba;
 *  - `checks`: qué se comprueba, empezando por «B → » («B → 404 sobre el
 *    paciente de A y su hoja no cambia»);
 *  - `routes`: las rutas (`MÉTODO /ruta`, como en `ROUTE_ACCESS`).
 *
 * Y el spec citado lo declara con un marcador por ruta, en un comentario
 * justo encima del test que la ataca:
 *
 *     // ISOLATION_COVERS: POST /patients/:patientId/sedation
 *
 * `exemptionProblems` falla (con la ruta y el fichero) si el spec no existe,
 * no lleva el marcador de la ruta, el marcador no está justo encima de un
 * `it(`/`test(` activo (solo comentarios en medio; ni `skip`, ni `todo`, ni
 * suelto en otra parte del fichero) o no menciona su último tramo fijo (p. ej.
 * `checklist`) fuera de los marcadores, si `checks` no empieza por «B → » con algo detrás, si una
 * ruta está exenta dos veces o si un spec citado declara una ruta que nadie
 * exime (el marcador quedó huérfano).
 *
 * Una PR que sube el número de exenciones (sale en el log de la matriz) lo
 * justifica en su descripción.
 */

export interface IsolationExemption {
  /** Fichero de `test/` (solo el nombre) que ataca las rutas desde B. */
  spec: string;
  /** Qué se comprueba: «B → 404 … y nada de A cambia». */
  checks: string;
  /** `MÉTODO /ruta` de cada ruta exenta. */
  routes: readonly string[];
}

export const ISOLATION_COVERS_MARKER = 'ISOLATION_COVERS:';

const MARKER_LINE = new RegExp(
  `${ISOLATION_COVERS_MARKER}\\s*((?:GET|POST|PUT|PATCH|DELETE) /\\S+)`,
  'g',
);

/**
 * Cabecera de un test activo: `it(`, `test(` o `it.each(...)(`, pero no
 * `it.skip`, `xit`, `it.todo` ni `describe`.
 */
const LIVE_TEST = /^\s*(?:it|test)(?:\.each\b.*)?\(/;
const COMMENT = /^\s*\/\//;

/** «B → » seguido de al menos tres palabras que digan qué se comprueba. */
const CHECKS = /^B → \S+(?:\s+\S+){2,}/;

const SPEC_NAME = /^[a-z0-9-]+\.(?:e2e|int)-spec\.ts$/;

/** Rutas que declara un spec con `// ISOLATION_COVERS: MÉTODO /ruta`. */
export function isolationCoversIn(source: string): string[] {
  return [...source.matchAll(MARKER_LINE)].map((m) => m[1]);
}

/**
 * Rutas cuyo marcador es un comentario justo encima de un test activo (solo
 * otros comentarios en medio).
 */
export function isolationCoversAttachedToTests(source: string): string[] {
  const lines = source.split('\n');
  const attached: string[] = [];
  lines.forEach((line, i) => {
    if (!COMMENT.test(line)) return;
    const routes = isolationCoversIn(line);
    if (routes.length === 0) return;
    let next = i + 1;
    while (next < lines.length && COMMENT.test(lines[next])) next++;
    if (next < lines.length && LIVE_TEST.test(lines[next])) {
      attached.push(...routes);
    }
  });
  return attached;
}

/**
 * Último tramo fijo de la ruta (`checklist` en `…/sedation/checklist`,
 * `anesthetics` en `/anesthetics/:id`): el spec tiene que mencionarlo al
 * construir la URL que ataca.
 */
export function lastStaticSegment(route: string): string {
  const segments = route
    .split(' ')[1]
    .split('/')
    .filter((s) => s !== '' && !s.startsWith(':'));
  return segments[segments.length - 1] ?? '';
}

/** Todas las rutas exentas, en el orden de la lista. */
export function exemptedRoutes(
  exemptions: readonly IsolationExemption[],
): string[] {
  return exemptions.flatMap((e) => [...e.routes]);
}

export interface ExemptionProblems {
  /** Ruta exenta más de una vez. */
  duplicada: string[];
  /** `ruta → checks` cuyo comentario no empieza por «B → …». */
  sinComentarioB: string[];
  /** `ruta → spec` cuyo fichero no existe (o no es un spec de `test/`). */
  specInexistente: string[];
  /** `ruta → spec` sin el marcador `ISOLATION_COVERS` de la ruta. */
  sinMarcador: string[];
  /** `ruta → spec` cuyo marcador no está encima de un test activo. */
  marcadorSinTest: string[];
  /** `ruta → spec` que no menciona el último tramo fijo de la ruta. */
  specSinRuta: string[];
  /** `spec: ruta` declarada en un spec citado que ninguna exención cita. */
  marcadorHuerfano: string[];
}

/**
 * Problemas de la lista de exenciones. `readSpec` devuelve el fuente de un
 * fichero de `test/` o `undefined` si no existe (ver `readTestSpec`).
 */
export function exemptionProblems(
  exemptions: readonly IsolationExemption[],
  readSpec: (spec: string) => string | undefined,
): ExemptionProblems {
  const problems: ExemptionProblems = {
    duplicada: [],
    sinComentarioB: [],
    specInexistente: [],
    sinMarcador: [],
    marcadorSinTest: [],
    specSinRuta: [],
    marcadorHuerfano: [],
  };
  const all = exemptedRoutes(exemptions);
  problems.duplicada = [...new Set(all.filter((r, i) => all.indexOf(r) !== i))];

  const sources = new Map<string, string | undefined>();
  const sourceOf = (spec: string) => {
    if (!sources.has(spec)) {
      sources.set(spec, SPEC_NAME.test(spec) ? readSpec(spec) : undefined);
    }
    return sources.get(spec);
  };

  for (const { spec, checks, routes } of exemptions) {
    const source = sourceOf(spec);
    const declared = source === undefined ? [] : isolationCoversIn(source);
    const attached =
      source === undefined ? [] : isolationCoversAttachedToTests(source);
    // El tramo se busca fuera de los marcadores (que ya lo contienen).
    const code =
      source
        ?.split('\n')
        .filter((line) => !line.includes(ISOLATION_COVERS_MARKER))
        .join('\n') ?? '';
    for (const route of routes) {
      if (!CHECKS.test(checks)) {
        problems.sinComentarioB.push(`${route} → ${checks}`);
      }
      if (source === undefined) {
        problems.specInexistente.push(`${route} → ${spec}`);
        continue;
      }
      if (!declared.includes(route)) {
        problems.sinMarcador.push(`${route} → ${spec}`);
      } else if (!attached.includes(route)) {
        problems.marcadorSinTest.push(`${route} → ${spec}`);
      }
      if (!code.includes(lastStaticSegment(route))) {
        problems.specSinRuta.push(`${route} → ${spec}`);
      }
    }
  }

  for (const [spec, source] of sources) {
    if (source === undefined) continue;
    const cited = new Set(
      exemptions.filter((e) => e.spec === spec).flatMap((e) => e.routes),
    );
    for (const route of new Set(isolationCoversIn(source))) {
      if (!cited.has(route))
        problems.marcadorHuerfano.push(`${spec}: ${route}`);
    }
  }
  return problems;
}

/** Lector de `exemptionProblems` sobre los ficheros de `testDir`. */
export function readTestSpec(testDir: string) {
  return (spec: string): string | undefined => {
    const file = path.join(testDir, spec);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  };
}
