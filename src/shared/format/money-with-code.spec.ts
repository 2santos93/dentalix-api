import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moneyWithCode } from './money-with-code';
import { regionalFormat, type HourCycle } from './regional-format';
import type { CurrencyTexts } from './currency-text';

type ReceiptFormatCase = { locale: string; hourCycle: HourCycle } & (
  | {
      op: 'moneyWithCode';
      args: [number, string, CurrencyTexts];
      expected: string;
    }
  | { op: 'dateTime' | 'date'; args: [string, string]; expected: string }
  | { op: 'civilDate'; args: [string]; expected: string }
);

/**
 * DX-521: vectores COMPARTIDOS con la web (`src/lib/format/receipt-format.cases.json`,
 * copia byte a byte; `scripts/check-api-reference-sync.mjs` de la web falla si
 * divergen). Los ajustes son los de las sedes de la demo (`DEMO_LOCATIONS`):
 * es-VE / America/Caracas, pt-BR / America/Sao_Paulo y en-GB / Europe/London,
 * todas con reloj de 24 h, más un caso de 12 h (en-US). Capturados con
 * Node 24 / ICU 77.1; solo locales cuyo resultado no cambia entre versiones
 * de ICU. Un JSON no admite comentarios: esta nota es el único registro.
 */
const CASES: ReceiptFormatCase[] = JSON.parse(
  readFileSync(join(__dirname, 'receipt-format.cases.json'), 'utf8'),
) as ReceiptFormatCase[];

describe('formato del recibo con la región de su sede (DX-521)', () => {
  it.each(
    CASES.map(
      (c) =>
        [
          `${c.locale} ${c.hourCycle} ${c.op} ${JSON.stringify(c.args)}`,
          c,
        ] as const,
    ),
  )('vector %s', (_name, c) => {
    const fmt = regionalFormat({ locale: c.locale, hourCycle: c.hourCycle });
    switch (c.op) {
      case 'moneyWithCode':
        expect(moneyWithCode(c.args[0], c.args[1], fmt, c.args[2])).toBe(
          c.expected,
        );
        break;
      case 'dateTime':
        expect(fmt.dateTime(new Date(c.args[0]), c.args[1])).toBe(c.expected);
        break;
      case 'date':
        expect(fmt.date(new Date(c.args[0]), c.args[1])).toBe(c.expected);
        break;
      case 'civilDate':
        expect(fmt.civilDate(c.args[0])).toBe(c.expected);
        break;
    }
  });

  it('los vectores cubren Londres en invierno y en verano, un reloj de 12 h y un instante que cambia de día según la sede', () => {
    const dateTimes = CASES.filter((c) => c.op === 'dateTime');
    const londres = dateTimes.filter((c) => c.locale === 'en-GB');
    expect(londres.map((c) => c.expected)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('14:30'),
        expect.stringContaining('15:30'),
      ]),
    );
    expect(CASES.some((c) => c.hourCycle === 'h12')).toBe(true);
    const nextDay = CASES.filter(
      (c) => c.op === 'date' && c.args[0] === '2026-11-02T01:30:00Z',
    ).map((c) => c.expected);
    expect(new Set(nextDay).size).toBeGreaterThan(1);
  });
});

describe('moneyWithCode (DX-521)', () => {
  const es = regionalFormat({ locale: 'es-VE', hourCycle: 'h23' });

  it('sin texto propio escribe el código ISO, nunca un símbolo', () => {
    expect(moneyWithCode(150000, 'USD', es, undefined)).not.toContain('$');
    expect(moneyWithCode(150000, 'USD', es, undefined)).toContain('USD');
    expect(
      moneyWithCode(
        65,
        'GBP',
        regionalFormat({ locale: 'en-GB', hourCycle: 'h23' }),
        null,
      ),
    ).toMatch(/GBP/);
  });

  it('con el texto de la moneda lo pone en lugar del código', () => {
    expect(moneyWithCode(1234.5, 'VES', es, { VES: 'Bs.' })).toBe(
      'Bs. 1.234,50',
    );
  });

  it('un texto de otra moneda no afecta a esta', () => {
    expect(moneyWithCode(10, 'USD', es, { VES: 'Bs.' })).toContain('USD');
  });

  it('una moneda sin unidad menor y entera va sin decimales', () => {
    expect(moneyWithCode(1234, 'JPY', es, undefined)).not.toMatch(/[.,]00/);
  });

  it('un código mal formado se pinta delante de la cifra, sin lanzar', () => {
    expect(moneyWithCode(5, 'US', es, undefined)).toBe('US 5,00');
  });
});
