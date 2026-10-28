const UNITS = [
  '',
  'uno',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'dieciséis',
  'diecisiete',
  'dieciocho',
  'diecinueve',
  'veinte',
  'veintiuno',
  'veintidós',
  'veintitrés',
  'veinticuatro',
  'veinticinco',
  'veintiséis',
  'veintisiete',
  'veintiocho',
  'veintinueve',
];
const TENS = [
  '',
  '',
  '',
  'treinta',
  'cuarenta',
  'cincuenta',
  'sesenta',
  'setenta',
  'ochenta',
  'noventa',
];
const HUNDREDS = [
  '',
  'ciento',
  'doscientos',
  'trescientos',
  'cuatrocientos',
  'quinientos',
  'seiscientos',
  'setecientos',
  'ochocientos',
  'novecientos',
];

export const MAX_QUANTITY_IN_WORDS = 9999;

function belowHundred(n: number): string {
  if (n < 30) return UNITS[n];
  const unit = n % 10;
  return unit === 0
    ? TENS[Math.floor(n / 10)]
    : `${TENS[Math.floor(n / 10)]} y ${UNITS[unit]}`;
}

function belowThousand(n: number): string {
  if (n === 100) return 'cien';
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [HUNDREDS[hundreds], rest > 0 ? belowHundred(rest) : '']
    .filter(Boolean)
    .join(' ');
}

/**
 * Cardinal en español de 1 a 9999, como se escribe la cantidad total de una
 * receta en letras cuando la clínica lo pide: 21 → «veintiuno», 1500 → «mil
 * quinientos». La forma es la del número suelto, que es como se imprime entre
 * paréntesis junto a la cifra: «21 (veintiuno) cápsulas».
 */
export function quantityInWords(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_QUANTITY_IN_WORDS) {
    throw new RangeError(
      `Cantidad fuera de rango para escribir en letras: ${String(n)}`,
    );
  }
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const head =
    thousands === 0 ? '' : thousands === 1 ? 'mil' : `${UNITS[thousands]} mil`;
  return [head, rest > 0 ? belowThousand(rest) : ''].filter(Boolean).join(' ');
}
