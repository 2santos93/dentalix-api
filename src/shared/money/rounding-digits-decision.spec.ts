import { createHash } from 'node:crypto';
import { CURRENCY_DIGITS } from '../../../prisma/reference/currency-digits';

/**
 * DX-488, decisión 1 (tomada, README «Redondeo de importes»): la unidad de
 * redondeo de una línea es la unidad más pequeña EN USO de la moneda. Las 13
 * monedas con 2 minor units ISO y ninguna fracción en uso se quedan con
 * `roundingDigits` 0.
 *
 * Qué fija el hash: el SHA-256 de los códigos de ese conjunto (minorUnits 2 y
 * roundingDigits 0 en `prisma/reference/currency-digits.ts`), ordenados y
 * unidos por comas. La prueba no escribe ningún código: si cambian los dígitos
 * de una sola moneda (una regeneración de la referencia, un cambio de su
 * generador), el conjunto cambia y el hash ya no coincide.
 *
 * Cómo actualizarlo a propósito: solo con la decisión de producto tomada (con
 * su migración de datos y el README al día), recalcula el hash con
 * `node -e` sobre la referencia nueva (filtra, ordena, `join(',')`, sha256 en
 * hex), revisa en el diff de `currency-digits.ts` qué moneda cambió, y pon aquí
 * el valor y el número de monedas nuevos.
 */
const EXPECTED_COUNT = 13;
const EXPECTED_SHA256 =
  'adb96329e4587e4cfadd6650c6e035c416d78a399674351d2fd3155d97933cc1';

const zeroRounded = CURRENCY_DIGITS.filter(
  (c) => c.minorUnits === 2 && c.roundingDigits === 0,
)
  .map((c) => c.code)
  .sort();

describe('dígitos de redondeo 0 en monedas con 2 minor units ISO (DX-488, decisión 1)', () => {
  it('son exactamente 13', () => {
    expect(zeroRounded).toHaveLength(EXPECTED_COUNT);
  });

  it('son las mismas 13 de la decisión (SHA-256 de los códigos ordenados)', () => {
    expect(
      createHash('sha256').update(zeroRounded.join(',')).digest('hex'),
    ).toBe(EXPECTED_SHA256);
  });

  it('VES y USD no están: siguen a céntimos', () => {
    expect(zeroRounded).not.toContain('VES');
    expect(zeroRounded).not.toContain('USD');
  });
});
