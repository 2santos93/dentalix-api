/**
 * DX-422 (H1): un nombre de fichero en ASCII legible. Quita los diacríticos
 * (NFKD: «í» → «i», «ñ» → «n») y translitera la tipografía habitual en vez de
 * perderla: rayas → «-», comillas (también « ») → «'», «…» → «...», «€» →
 * «EUR». Lo que quede fuera de ASCII imprimible lo decide quien llama.
 */
const TYPOGRAPHY: Record<string, string> = {
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '–': '-',
  '—': '-',
  '―': '-',
  '−': '-',
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '“': "'",
  '”': "'",
  '„': "'",
  '«': "'",
  '»': "'",
  '‹': "'",
  '›': "'",
  '…': '...',
  '€': 'EUR',
};

export function transliterateToAscii(text: string): string {
  return Array.from(text.normalize('NFKD').replace(/[̀-ͯ]/g, ''))
    .map((c) => TYPOGRAPHY[c] ?? c)
    .join('');
}
