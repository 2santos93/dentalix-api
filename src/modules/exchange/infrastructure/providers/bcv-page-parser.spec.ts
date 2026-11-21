import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BcvPageFormatError, parseBcvPage } from './bcv-page-parser';

// DX-585: la portada real del BCV (recortada) guardada como fixture: los
// tests nunca consultan la red.
const FIXTURE = readFileSync(
  join(__dirname, '__fixtures__', 'bcv-home-2026-11-21.html'),
  'utf8',
);

describe('parseBcvPage (DX-585)', () => {
  it('lee USD, EUR y la «Fecha Valor» de la portada real', () => {
    expect(parseBcvPage(FIXTURE)).toEqual({
      usdVes: 919.8227,
      eurVes: 1011.17949056,
      valueDate: '2026-11-24',
    });
  });

  it('la fecha de otro bloque (reservas, 19/11) no se toma por la «Fecha Valor»', () => {
    expect(FIXTURE).toContain('2026-11-19T00:00:00-04:00');
    expect(parseBcvPage(FIXTURE).valueDate).toBe('2026-11-24');
  });

  it('sin el atributo `content`, lee la fecha escrita («Martes, 24 Noviembre 2026»)', () => {
    const html = FIXTURE.replace(
      /content="2026-11-24T00:00:00-04:00"/,
      'data-x="1"',
    );
    expect(parseBcvPage(html).valueDate).toBe('2026-11-24');
  });

  it('formato es con miles: «1.011,17949056»', () => {
    const html = FIXTURE.replace('919,82270000', '1.919,82270000');
    expect(parseBcvPage(html).usdVes).toBe(1919.8227);
  });

  it.each([
    [
      'sin el bloque #dolar',
      (h: string) => h.replace('id="dolar"', 'id="otro"'),
      'falta el bloque #dolar',
    ],
    [
      'sin el bloque #euro',
      (h: string) => h.replace('id="euro"', 'id="otro"'),
      'falta el bloque #euro',
    ],
    [
      'la cifra del dólar ya no va en <strong>',
      (h: string) =>
        h.replace(
          '<strong class="strong-tb">919,82270000</strong>',
          '<b>919,82270000</b>',
        ),
      '#dolar sin la cifra',
    ],
    [
      'una cifra en otro formato',
      (h: string) => h.replace('919,82270000', '919.82'),
      '#dolar con una cifra ilegible',
    ],
    [
      'sin «Fecha Valor»',
      (h: string) => h.replace('Fecha Valor', 'Fecha'),
      'falta la «Fecha Valor»',
    ],
    [
      'una «Fecha Valor» ilegible',
      (h: string) =>
        h
          .replace(/content="2026-11-24T00:00:00-04:00"/, '')
          .replace('Martes, 24 Noviembre  2026', 'próximamente'),
      '«Fecha Valor» ilegible',
    ],
    [
      'otra página entera',
      () => '<html><body>Mantenimiento</body></html>',
      'falta el bloque #dolar',
    ],
  ])(
    'HTML cambiado (%s) → error controlado, sin tasa a medias',
    (_, change, reason) => {
      let error: unknown;
      try {
        parseBcvPage(change(FIXTURE));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(BcvPageFormatError);
      expect((error as BcvPageFormatError).reason).toBe(reason);
    },
  );
});
