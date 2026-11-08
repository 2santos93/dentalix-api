import {
  IsNumber,
  IsPositive,
  Min,
  ValidateBy,
  ValidationOptions,
  buildMessage,
} from 'class-validator';
import {
  AMOUNT_NON_NEGATIVE_MESSAGE,
  PAYMENT_AMOUNT_MESSAGE,
  boundedDecimalMessage,
} from '../money/currency-messages';

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
  /** Sujeto del mensaje por defecto («El importe», «El valor»). */
  subject?: string;
}

/**
 * Número finito con como mucho `maxDecimals` decimales y `|valor| <= maxAbs`.
 * No fija el signo: cada DTO lo sigue diciendo con `@Min`/`@IsPositive`.
 */
export function IsBoundedDecimal(
  { maxDecimals, maxAbs, subject }: BoundedDecimalOptions,
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
        // DX-517-quater: en español neutro, con el máximo formateado.
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}${boundedDecimalMessage(maxDecimals, maxAbs, subject)}`,
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
    { maxDecimals: 2, maxAbs: MONEY_MAX, subject: 'El importe' },
    validationOptions,
  );
}

/**
 * Importe mayor que 0 (cobros): número, positivo y `IsMoney`, los tres en
 * español. `message` sustituye al texto de «número / mayor que 0».
 */
export function IsPositiveMoney(
  message: string = PAYMENT_AMOUNT_MESSAGE,
): PropertyDecorator {
  const decorators = [
    IsNumber({}, { message }),
    IsPositive({ message }),
    IsMoney(),
  ];
  return (target, key) => decorators.forEach((d) => d(target, key));
}

/**
 * Importe mayor o igual que 0 (precios, pie, total a financiar): número, no
 * negativo y `IsMoney`, en español. `message` sustituye al de número / signo.
 */
export function IsNonNegativeMoney(
  message: string = AMOUNT_NON_NEGATIVE_MESSAGE,
): PropertyDecorator {
  const decorators = [
    IsNumber({}, { message }),
    Min(0, { message }),
    IsMoney(),
  ];
  return (target, key) => decorators.forEach((d) => d(target, key));
}

/** Cantidad de inventario: 3 decimales como mucho y hasta `QUANTITY_MAX`. */
export function IsQuantity(validationOptions?: ValidationOptions) {
  return IsBoundedDecimal(
    { maxDecimals: 3, maxAbs: QUANTITY_MAX },
    validationOptions,
  );
}
