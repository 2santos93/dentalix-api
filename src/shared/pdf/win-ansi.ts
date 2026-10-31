/**
 * Lo que las fuentes estándar de pdfkit (Helvetica, codificación WinAnsi)
 * pintan tal cual: ASCII imprimible, Latin-1 (0xA0–0xFF) y los 27 signos de
 * 0x80–0x9F (€, —, “”, …). El español, el portugués y el resto de lenguas de
 * Europa occidental caben enteros.
 */
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split(''));

const LINE_BREAKS = /[\r\n\t]+/g;
const COMBINING_MARKS = /[̀-ͯ]/g;

export function isWinAnsiChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x20 && code <= 0x7e) ||
    (code >= 0xa0 && code <= 0xff) ||
    WIN_ANSI_EXTRA.has(ch)
  );
}

/**
 * Un texto de UNA línea que la fuente pinta sin cambiar letras por otras
 * (DX-339, agenda de contingencia): lo que ya cabe queda igual; lo que tiene
 * una forma base que cabe se translitera (NFKD sin diacríticos: «ř» → «r»,
 * los espacios finos de Intl → espacio); el resto (otros alfabetos, emojis)
 * sale como «?». Los saltos de línea y tabuladores, como un espacio.
 *
 * Para documentos operativos; un documento probatorio (DX-422) NO se
 * translitera: rechaza el texto que no cabe.
 */
export function toWinAnsi(text: string): string {
  return Array.from(text.replace(LINE_BREAKS, ' ').trim())
    .map((ch) => {
      if (isWinAnsiChar(ch)) return ch;
      const base = ch.normalize('NFKD').replace(COMBINING_MARKS, '');
      return base !== '' && Array.from(base).every(isWinAnsiChar) ? base : '?';
    })
    .join('');
}
