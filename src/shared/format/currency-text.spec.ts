import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CURRENCY_TEXT_MAX,
  NO_CURRENCY_TEXTS,
  currencyTextFor,
  isCurrencyText,
  moneyWithCurrencyText,
  readCurrencyTexts,
  type CurrencyTexts,
} from './currency-text';
import { regionalFormat } from './regional-format';

interface CurrencyTextCase {
  locale: string;
  amount: number;
  currency: string;
  texts: CurrencyTexts;
  expected: string;
}

/**
 * DX-517: vectores COMPARTIDOS con la web (`src/lib/format/currency-text.cases.json`,
 * copia byte a byte; `scripts/check-api-reference-sync.mjs` de la web falla si
 * divergen). Capturados con Node 24 / ICU 77.1, como los de `regional-format`.
 */
const CASES: CurrencyTextCase[] = JSON.parse(
  readFileSync(join(__dirname, 'currency-text.cases.json'), 'utf8'),
) as CurrencyTextCase[];

describe('texto propio de cada moneda (DX-517)', () => {
  it.each(CASES.map((c) => [`${c.locale} ${c.amount} ${c.currency}`, c]))(
    'vector %s',
    (_name, c) => {
      const fmt = regionalFormat({ locale: c.locale, hourCycle: 'h23' });
      expect(fmt.money(c.amount, c.currency, c.texts)).toBe(c.expected);
      const text = currencyTextFor(c.texts, c.currency)!;
      expect(
        moneyWithCurrencyText(
          c.amount,
          c.currency.toUpperCase(),
          c.locale,
          text,
        ),
      ).toBe(c.expected);
    },
  );

  it('el criterio: «VES → Bs.» en es-VE es «Bs. 1.234,50» (símbolo delante, con el espacio del locale)', () => {
    const fmt = regionalFormat({ locale: 'es-VE', hourCycle: 'h12' });
    expect(fmt.money(1234.5, 'VES', { VES: 'Bs.' })).toBe('Bs.\u00a01.234,50');
  });

  it('sin texto para esa moneda, `money` da exactamente lo de antes', () => {
    for (const locale of ['es-VE', 'en-US', 'de-DE', 'pt-BR', 'ja-JP']) {
      const fmt = regionalFormat({ locale, hourCycle: 'h23' });
      for (const [amount, currency] of [
        [1234.5, 'VES'],
        [1234, 'USD'],
        [1234, 'JPY'],
        [1234.5, 'XYZ'],
        [1234.5, 'US'],
      ] as const) {
        const before = fmt.money(amount, currency);
        expect(fmt.money(amount, currency, undefined)).toBe(before);
        expect(fmt.money(amount, currency, null)).toBe(before);
        expect(fmt.money(amount, currency, NO_CURRENCY_TEXTS)).toBe(before);
        expect(fmt.money(amount, currency, { EUR: 'Euro' })).toBe(before);
      }
    }
  });

  it('un código que Intl no acepta pone el texto delante de la cifra', () => {
    expect(moneyWithCurrencyText(1234.5, 'US', 'es-VE', 'X')).toBe(
      'X 1.234,50',
    );
  });

  describe('validez del texto', () => {
    it.each(['Bs.', 'US$', '€', 'Bs S', 'ABCDEFGH', 'ج.م.', '円'])(
      'acepta %j',
      (text) => expect(isCurrencyText(text)).toBe(true),
    );
    it.each([
      '',
      ' Bs.',
      'Bs. ',
      'ABCDEFGHI',
      'Bs\n',
      'B\u0000s',
      'B\u200es',
      'B\u2028s',
      42,
      null,
    ])('rechaza %j', (text) => expect(isCurrencyText(text)).toBe(false));

    it(`cuenta caracteres, no unidades UTF-16 (tope ${CURRENCY_TEXT_MAX})`, () => {
      expect(isCurrencyText('😀'.repeat(CURRENCY_TEXT_MAX))).toBe(true);
      expect(isCurrencyText('😀'.repeat(CURRENCY_TEXT_MAX + 1))).toBe(false);
    });
  });

  it('`readCurrencyTexts` ignora lo que no es un mapa válido y nunca lanza', () => {
    expect(readCurrencyTexts(null)).toEqual({});
    expect(readCurrencyTexts([])).toEqual({});
    expect(readCurrencyTexts('VES')).toEqual({});
    expect(
      readCurrencyTexts({ VES: 'Bs.', usd: 'US$', EUR: '', GBP: 7, JPY: '円' }),
    ).toEqual({ VES: 'Bs.', JPY: '円' });
  });

  it('`currencyTextFor` busca el código en mayúsculas', () => {
    expect(currencyTextFor({ VES: 'Bs.' }, 'ves')).toBe('Bs.');
    expect(currencyTextFor({ VES: 'Bs.' }, 'USD')).toBeUndefined();
    expect(currencyTextFor(null, 'VES')).toBeUndefined();
  });
});
