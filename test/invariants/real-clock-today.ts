import { isCheckedSpec, type SpecSource } from './bare-delete-many';

// DX-449 (TST-053) y DX-495 (TST-062): qué spec calcula «hoy» con el reloj
// real sin pasar por `test/support/sede-clock.ts`. Lo usa
// `sede-today.spec.ts`; va aparte para poder pasárselo a un fichero suelto
// (p. ej. la versión anterior de un spec, como prueba en una PR).

const TODAY_IDENTIFIER = /\b\w*(?:today|Today|TODAY)\w*\b/;
const REAL_CLOCK = /\bDate\.now\(\)|\bnew Date\(\)/;
const SEDE_CLOCK_IMPORT = /from '\.\/support\/sede-clock'/;

// DX-495 (TST-062): el «hoy» en español. Un identificador (`citaDeHoy`) o el
// título de un `describe`/`it`/`test` («una cita de hoy»); no un mensaje
// esperado de la API («Solo puedes anular abonos registrados hoy»).
const HOY_IDENTIFIER = /\b\w*(?:hoy|Hoy|HOY)\w*\b/;
const HOY_WORD = /(?<![\p{L}\p{N}_])(?:hoy|Hoy|HOY)(?![\p{L}\p{N}_])/u;
const TEST_TITLE =
  /\b(?:describe|it|test)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
// DX-495: una cita «de hace N» con el reloj real que pasa a ARRIVED o IN_CHAIR
// (la API exige que sea de hoy en la sede), aunque nada se llame «hoy».
const STARTED_AGO = /\bDate\.now\(\)\s*-\s*[\w(]/;
const ARRIVAL_STATUS = /\b(?:ARRIVED|IN_CHAIR)\b/;

/** El código sin comentarios: un «today» en prosa no cuenta. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** El código sin el contenido de los literales de texto. */
function withoutStrings(body: string): string {
  return body.replace(
    /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
    "''",
  );
}

// Un «hoy» entre comillas angulares cita un texto de la interfaz («Sin
// cambios hoy»), no el día de la sede.
const UI_QUOTE = /«[^»]*»/g;

function namesHoy(body: string): boolean {
  if (HOY_IDENTIFIER.test(withoutStrings(body))) return true;
  return [...body.matchAll(TEST_TITLE)].some(([, , title]) =>
    HOY_WORD.test(title.replace(UI_QUOTE, '')),
  );
}

/** Cada `it`/`test` con su cuerpo (hasta el siguiente). */
function testBlocks(body: string): string[] {
  return body.split(/(?=\b(?:it|test)(?:\.\w+)*\()/);
}

/** Un test que lleva a ARRIVED/IN_CHAIR una cita de `Date.now() - n`. */
function arrivesStartedAgo(body: string): boolean {
  return testBlocks(body).some(
    (block) => STARTED_AGO.test(block) && ARRIVAL_STATUS.test(block),
  );
}

/**
 * Specs con BD que leen el reloj real sin sede-clock y nombran «hoy»
 * (today/hoy en un identificador o un título) o llevan a ARRIVED/IN_CHAIR
 * una cita de `Date.now() - n`.
 */
export function findRealClockToday(specs: SpecSource[]): string[] {
  return specs
    .filter((s) => isCheckedSpec(s.path))
    .filter((s) => {
      if (SEDE_CLOCK_IMPORT.test(s.source)) return false;
      const body = code(s.source);
      const today =
        (TODAY_IDENTIFIER.test(body) || namesHoy(body)) &&
        REAL_CLOCK.test(body);
      return today || arrivesStartedAgo(body);
    })
    .map((s) => s.path)
    .sort();
}
