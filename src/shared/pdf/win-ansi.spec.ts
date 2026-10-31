import { isWinAnsiChar, toWinAnsi } from './win-ansi';

describe('WinAnsi de las fuentes estándar del PDF (DX-339)', () => {
  it('reconoce el ASCII imprimible, Latin-1 y los signos de 0x80–0x9F', () => {
    for (const ch of ['a', 'Z', '7', ' ', 'ñ', 'Á', 'ü', '¿', '€', '—', '“']) {
      expect(isWinAnsiChar(ch)).toBe(true);
    }
  });

  it('no reconoce otros alfabetos, emojis ni controles', () => {
    for (const ch of ['李', 'Ж', '😀', '\t', ' ', 'ł']) {
      expect(isWinAnsiChar(ch)).toBe(false);
    }
  });

  it('deja tal cual el español y el portugués', () => {
    expect(toWinAnsi('José Muñoz — «Ação» 1,5 €')).toBe(
      'José Muñoz — «Ação» 1,5 €',
    );
  });

  it('translitera lo que tiene forma base (ř, Ő, ź) y cambia el resto por «?»', () => {
    expect(toWinAnsi('Dvořák Őrs Łódź')).toBe('Dvorák Ors ?ódz');
    expect(toWinAnsi('李 Wei 😀')).toBe('? Wei ?');
  });

  it('los espacios finos de Intl salen como espacio normal', () => {
    expect(toWinAnsi('4:05 p. m.')).toBe('4:05 p. m.');
    expect(toWinAnsi('a b c')).toBe('a b c');
  });

  it('los saltos de línea y tabuladores salen como espacio (una celda es una línea)', () => {
    expect(toWinAnsi('Ana\nMaría\tLópez\r\n')).toBe('Ana María López');
  });
});
