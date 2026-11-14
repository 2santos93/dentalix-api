import { join } from 'node:path';
import { leavesWith } from '../support/content-leaves';
import {
  findShortNegativeLiterals,
  formatShortNegativeLiterals,
  readAllSpecs,
} from './short-negative-literal';
import type { SpecSource } from './bare-delete-many';

// DX-496 (TST-059): `expect(JSON.stringify(event)).not.toContain('204')`
// pretendía comprobar que la dosis no queda en la auditoría, pero el JSON lleva
// UUID y milisegundos: `…57.204Z` o `58a0931b-e204-…` lo ponían en rojo al azar
// (≈ 6 % de las runs). Un assert negativo de texto con un literal corto de
// cifras o hex (menos de 6 caracteres) no prueba nada sobre un texto con ids y
// horas. Se comprueba en los campos que pueden llevar el dato
// (`leavesWith` de test/support/content-leaves.ts, o un `toEqual` exacto) o
// con un centinela de 6 caracteres o más.

const REPO_ROOT = join(__dirname, '..', '..');

const spec = (source: string, path = 'test/nuevo.e2e-spec.ts'): SpecSource => ({
  path,
  source,
});

describe('DX-496: asserts negativos sin literales numéricos cortos', () => {
  describe('findShortNegativeLiterals', () => {
    it('detecta el patrón de TST-059 y sus variantes', () => {
      const found = findShortNegativeLiterals([
        spec(
          [
            "expect(JSON.stringify(events[0])).not.toContain('204');",
            'expect(JSON.stringify(audit?.metadata)).not.toContain("0412");',
            'expect(text).not.toContain(`146`);',
            'expect(dump).not.toMatch(/204/);',
            'expect(JSON.stringify(info)).not.toMatch(/6c1d|ana/i);',
            'expect(res.body).toEqual(expect.not.stringContaining("20"));',
            'expect(json)',
            '  .not.toContain(',
            "    '9f00',",
            '  );',
            "expect(JSON.stringify(events.map((e) => e.metadata))).not.toContain('175');",
          ].join('\n'),
        ),
      ]);
      expect(found.map((f) => [f.line, f.literal])).toEqual([
        [1, '204'],
        [2, '0412'],
        [3, '146'],
        [4, '204'],
        [5, '6c1d'],
        [6, '20'],
        [8, '9f00'],
        [11, '175'],
      ]);
    });

    it('resuelve constantes del mismo fichero, String() y plantillas', () => {
      const found = findShortNegativeLiterals([
        spec(
          [
            'const DOSE = 204;',
            "const REF = '0412';",
            "const OVERRIDE = 'Exodoncia infantil compleja';",
            'expect(JSON.stringify(e)).not.toContain(String(DOSE));',
            'expect(JSON.stringify(e)).not.toContain(`${DOSE}`);',
            'expect(JSON.stringify(e)).not.toContain(REF);',
            'expect(JSON.stringify(e)).not.toContain(OVERRIDE);',
          ].join('\n'),
        ),
      ]);
      expect(found.map((f) => [f.line, f.literal])).toEqual([
        [4, '204'],
        [5, '204'],
        [6, '0412'],
      ]);
    });

    it('resuelve la variable de un for…of sobre una lista literal', () => {
      const found = findShortNegativeLiterals([
        spec(
          [
            "const REF = '0412';",
            'for (const leaked of [',
            "  'Juan',",
            "  '9b1e',",
            '  REF,',
            '  NUMBER.slice(0, -4),',
            "  '9b1e77aa',",
            ']) {',
            '  expect(text).not.toContain(leaked);',
            '}',
            "for (const leaked of ['Juan', '9b1e77aa']) {",
            '  expect(text).not.toContain(leaked);',
            '}',
          ].join('\n'),
        ),
      ]);
      expect(found.map((f) => [f.line, f.literal])).toEqual([
        [9, '9b1e'],
        [9, '0412'],
      ]);
    });

    it('ve las ramas de una regex con grupos, anclas y \\b', () => {
      const found = findShortNegativeLiterals([
        spec(
          [
            'expect(text).not.toMatch(/(204|146)/);',
            'expect(text).not.toMatch(/^204$/);',
            'expect(text).not.toMatch(/\\b0412\\b|(?:6c1d)/);',
          ].join('\n'),
        ),
      ]);
      expect(found.map((f) => [f.line, f.literal])).toEqual([
        [1, '204'],
        [1, '146'],
        [2, '204'],
        [3, '0412'],
        [3, '6c1d'],
      ]);
    });

    it('permite centinelas largos, texto, regex con clases y listas', () => {
      const found = findShortNegativeLiterals([
        spec(
          [
            "expect(JSON.stringify(events)).not.toContain('102030');",
            "expect(JSON.stringify(e)).not.toContain('cuotas');",
            "expect(text).not.toContain('abc');",
            'expect(MESSAGE).not.toMatch(/\\d/);',
            'expect(out).not.toMatch(/[0-9a-f]{64}/);',
            "expect(Object.keys(post.responses)).not.toContain('201');",
            "expect([...r.suggested, ...r.others]).not.toContain('c');",
            "expect(rows.map((r) => r.code)).not.toContain('204');",
            "expect(text).toContain('204');",
            "expect(fmt(x)).not.toContain(',');",
          ].join('\n'),
        ),
      ]);
      expect(found).toEqual([]);
    });

    it('revisa e2e, int, unit de src y owner-spec por igual', () => {
      const line = "expect(JSON.stringify(x)).not.toContain('204');";
      const found = findShortNegativeLiterals([
        spec(line, 'test/a.int-spec.ts'),
        spec(line, 'src/modules/x/y.spec.ts'),
        spec(line, 'test/owner-nosu/z.owner-spec.ts'),
      ]);
      expect(found.map((f) => f.path)).toEqual([
        'test/a.int-spec.ts',
        'src/modules/x/y.spec.ts',
        'test/owner-nosu/z.owner-spec.ts',
      ]);
      expect(formatShortNegativeLiterals(found)).toMatch(
        /test\/a\.int-spec\.ts:1: .*'204'.*leavesWith/,
      );
    });
  });

  describe('leavesWith (test/support/content-leaves.ts)', () => {
    const event = {
      id: '58a0931b-e204-4179-8a1c-0204aa55e204',
      resourceId: '01a19531-9b8e-7d23-990a-c1230166e204',
      requestId: '0256a80e-529b-46a5-8324-5fcd7f27a724',
      occurredAt: new Date('2026-10-31T17:23:57.204Z'),
      ip: '127.0.0.1',
      metadata: {
        params: { entryId: '48ff6c56-1def-47f5-83d9-e816b0dc2204' },
        at: '2026-10-31T17:23:57.204Z',
        duplicateOf: ['204a0931-0000-4000-8000-000000000204'],
        anesthesiaSafety: { blocking: ['DOSE_OVER_MAX'], overridden: true },
      },
    };

    it('no ve el dato en ids (UUID) ni en fechas: lo que tumbaba TST-059', () => {
      expect(JSON.stringify(event)).toContain('204');
      expect(leavesWith(event, 204)).toEqual([]);
      expect(leavesWith(event, '204')).toEqual([]);
    });

    it('sí lo ve en un número, en un texto o en una clave', () => {
      expect(leavesWith({ ...event, doseMg: 204 }, 204)).toEqual(['doseMg']);
      expect(
        leavesWith({ metadata: { notes: ['Dosis: 204 mg de 140 mg'] } }, '204'),
      ).toEqual(['metadata.notes[0]']);
      expect(leavesWith({ metadata: { d204: true } }, 204)).toEqual([
        'metadata.d204',
      ]);
      expect(leavesWith({ total: { toJSON: () => '204.00' } }, 204)).toEqual([
        'total',
      ]);
      expect(
        leavesWith({ total: { toJSON: () => ({ amount: 204 }) } }, 204),
      ).toEqual(['total.amount']);
      expect(leavesWith({ file: Buffer.from([2, 0, 4]) }, 204)).toEqual([]);
      expect(leavesWith({ file: Buffer.from('dosis 204') }, 204)).toEqual([]);
    });

    it('un texto que no es solo un UUID o una fecha sí se revisa', () => {
      expect(
        leavesWith({ ref: '58a0931b-e204-4179-8a1c-0204aa55e204 dosis' }, 204),
      ).toEqual(['ref']);
    });

    it('no se cuelga con ciclos: cada objeto se visita una vez', () => {
      const node: Record<string, unknown> = { note: 'Dosis 204 mg' };
      node.self = node;
      expect(leavesWith({ a: node, b: node }, 204)).toEqual(['a.note']);
      const list: unknown[] = ['204 mg'];
      list.push(list);
      expect(leavesWith(list, 204)).toEqual(['[0]']);
    });

    it('acepta el JSON ya leído y valores nulos', () => {
      expect(leavesWith(null, 204)).toEqual([]);
      expect(leavesWith(JSON.parse(JSON.stringify(event)), 204)).toEqual([]);
    });
  });

  it('ningún spec del repo hace un assert negativo con un literal numérico corto', () => {
    const found = findShortNegativeLiterals(readAllSpecs(REPO_ROOT));
    expect(formatShortNegativeLiterals(found)).toBe('');
  });
});
