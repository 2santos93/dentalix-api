import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { FREE_MAP_EXCEPTIONS, findBareObjects } from './openapi-bare-objects';

/**
 * DX-539: ningún DTO publica un campo como objeto vacío en el contrato OpenAPI.
 * `@ApiProperty({ type: Object })` (o `type: [Object]`) sale como
 * `Record<string, never>` en el `schema.d.ts` de la web, que acaba parcheando el
 * tipo a mano (DX-537). Dos puertas:
 *  1. Esta guarda de fuente, barata y sin base de datos: ningún `type: Object`
 *     ni `type: [Object]` en el código de producción.
 *  2. `test/openapi-no-bare-objects.e2e-spec.ts` monta la app y comprueba el
 *     documento real (`findBareObjects`), que también atrapa el `@ApiProperty`
 *     sin `type` sobre un `T | null`.
 * Un mapa libre de verdad se documenta con `additionalProperties` tipado; si no
 * tiene forma conocida, va en `FREE_MAP_EXCEPTIONS` con su motivo.
 */
const SRC = join(__dirname, '..');

const BARE_TYPE = /\btype\s*:\s*\[?\s*Object\s*\]?\s*[,}\n]/;

export function declaresBareObject(line: string): boolean {
  return BARE_TYPE.test(line);
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('sin objetos vacíos en el contrato OpenAPI (DX-539)', () => {
  it('ningún código de producción declara `type: Object`', () => {
    const files = tsFiles(SRC).filter(
      (f) => !f.endsWith('.spec.ts') && !f.split(sep).includes('__fixtures__'),
    );
    const offending = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          declaresBareObject(line)
            ? [`${relative(SRC, file).split(sep).join('/')}:${i + 1}`]
            : [],
        ),
    );
    expect(offending).toEqual([]);
  });

  it('autoprueba de la guarda de fuente', () => {
    expect(declaresBareObject('    type: Object,')).toBe(true);
    expect(declaresBareObject('@ApiProperty({ type: [Object] })')).toBe(true);
    expect(declaresBareObject("    type: 'object',")).toBe(false);
    expect(declaresBareObject('    type: ObjectIdDto,')).toBe(false);
    expect(declaresBareObject('    type: () => OverdueBalanceDto,')).toBe(
      false,
    );
  });

  it('el detector de documento distingue vacío, mapa tipado y mapa libre', () => {
    const doc = {
      components: {
        schemas: {
          A: {
            properties: {
              vacio: { type: 'object', nullable: true },
              sinTipo: { description: 'x', nullable: true },
              ref: { $ref: '#/components/schemas/B' },
              mapaTipado: {
                type: 'object',
                additionalProperties: { type: 'number' },
              },
              mapaLibre: { type: 'object', additionalProperties: true },
              lista: { type: 'array', items: { type: 'object' } },
              texto: { type: 'string', nullable: true },
            },
          },
          FailedJobDto: {
            properties: {
              payload: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    };
    expect(findBareObjects(doc)).toEqual([
      'A.vacio',
      'A.sinTipo',
      'A.mapaLibre',
      'A.lista[]',
    ]);
  });

  it('cada excepción de mapa libre lleva su motivo', () => {
    for (const [path, reason] of Object.entries(FREE_MAP_EXCEPTIONS)) {
      expect(path).toMatch(/^\w+\.\w+$/);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
