import {
  currencyTextEntries,
  currencyTextsForAudit,
  parseCurrencyTextEntries,
} from './clinic-currency-texts';

const KNOWN = new Set(['VES', 'USD', 'EUR', 'JPY']);
const known = (code: string) => KNOWN.has(code);

describe('textos de moneda de la clínica (DX-517)', () => {
  it('normaliza: código en mayúsculas, texto recortado y orden alfabético', () => {
    expect(
      parseCurrencyTextEntries(
        [
          { currency: 'usd', text: ' US$ ' },
          { currency: 'VES', text: 'Bs.' },
        ],
        known,
      ),
    ).toEqual({ ok: true, texts: { USD: 'US$', VES: 'Bs.' } });
    expect(parseCurrencyTextEntries([], known)).toEqual({
      ok: true,
      texts: {},
    });
  });

  it.each([
    [
      [{ currency: 'XYZ', text: 'X' }],
      '«XYZ» no es una moneda del catálogo (código ISO 4217 de tres letras).',
    ],
    [
      [{ currency: 'VE', text: 'X' }],
      '«VE» no es una moneda del catálogo (código ISO 4217 de tres letras).',
    ],
    [
      [{ currency: 'VES', text: '' }],
      'El texto de VES admite de 1 a 8 caracteres en una línea.',
    ],
    [
      [{ currency: 'VES', text: 'Bolívares' }],
      'El texto de VES admite de 1 a 8 caracteres en una línea.',
    ],
    [
      [{ currency: 'VES', text: 'B\ts' }],
      'El texto de VES admite de 1 a 8 caracteres en una línea.',
    ],
    [
      [
        { currency: 'VES', text: 'Bs.' },
        { currency: 'ves', text: 'Bs' },
      ],
      'VES aparece más de una vez.',
    ],
  ])('rechaza %j con su mensaje', (entries, message) => {
    expect(parseCurrencyTextEntries(entries, known)).toEqual({
      ok: false,
      message,
    });
  });

  it('hasta 30 monedas', () => {
    const many = Array.from({ length: 31 }, () => ({
      currency: 'VES',
      text: 'x',
    }));
    expect(parseCurrencyTextEntries(many, () => true)).toEqual({
      ok: false,
      message: 'Puedes dar texto propio a 30 monedas como mucho.',
    });
  });

  it('la lista de la API y el antes/después de la auditoría van en orden de código', () => {
    const texts = { VES: 'Bs.', EUR: '€' };
    expect(currencyTextEntries(texts)).toEqual([
      { currency: 'EUR', text: '€' },
      { currency: 'VES', text: 'Bs.' },
    ]);
    expect(currencyTextsForAudit(texts)).toEqual(['EUR=€', 'VES=Bs.']);
    expect(currencyTextsForAudit({})).toEqual([]);
  });
});
