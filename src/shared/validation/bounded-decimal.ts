import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';

/**
 * Tope de importes que acepta la API (DX-042, DB-010): 10 dígitos enteros y 2
 * decimales. Cabe en todas las columnas de dinero: `Decimal(12,2)` (precios
 * del plan y del catálogo, hasta 10 enteros) y `Decimal(14,2)` (abonos, planes
 * de pago y cuotas). Sin este tope un importe de 13 dígitos llegaba a la base
 * y respondía 500 (`numeric field overflow`), y uno con 3 decimales se
 * redondeaba en silencio.
 */
export const MONEY_MAX = 9_999_999_999.99;

/** Tope de cantidades de inventario: 10 enteros y 3 decimales (`Decimal(14,3)`). */
export const QUANTITY_MAX = 9_999_999_999.999;

/**
 * Decimales de un número tal como lo escribió el cliente. `String(n)` da la
 * representación más corta que vuelve al mismo número (`0.29`, no
 * `0.28999…`), así que cuenta lo que llegó en el JSON. Los números muy
 * pequeños salen en notación exponencial (`1e-7`): se cuentan también.
 */
export function decimalPlaces(value: number): number {
  const match = /^(?:\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(
    String(Math.abs(value)),
  );
  if (!match) {
    return Number.POSITIVE_INFINITY;
  }
  const fraction = match[1]?.length ?? 0;
  const exponent = match[2] ? Number(match[2]) : 0;
  return Math.max(0, fraction - exponent);
}

interface BoundedDecimalOptions {
  maxDecimals: number;
  maxAbs: number;
}

/**
 * Número finito con como mucho `maxDecimals` decimales y `|valor| <= maxAbs`.
 * No fija el signo: cada DTO lo sigue diciendo con `@Min`/`@IsPositive`.
 */
export function IsBoundedDecimal(
  { maxDecimals, maxAbs }: BoundedDecimalOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isBoundedDecimal',
      constraints: [maxDecimals, maxAbs],
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === 'number' &&
          Number.isFinite(value) &&
          Math.abs(value) <= maxAbs &&
          decimalPlaces(value) <= maxDecimals,
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must be a number with at most $constraint1 decimal places and an absolute value <= $constraint2`,
          validationOptions,
        ),
      },
    },
    validationOptions,
  );
}

/** Importe: 2 decimales como mucho y hasta `MONEY_MAX`. */
export function IsMoney(validationOptions?: ValidationOptions) {
  return IsBoundedDecimal(
    { maxDecimals: 2, maxAbs: MONEY_MAX },
    validationOptions,
  );
}

/** Cantidad de inventario: 3 decimales como mucho y hasta `QUANTITY_MAX`. */
export function IsQuantity(validationOptions?: ValidationOptions) {
  return IsBoundedDecimal(
    { maxDecimals: 3, maxAbs: QUANTITY_MAX },
    validationOptions,
  );
}
