import { ValidateBy, ValidationOptions } from 'class-validator';
import { decimalPlaces } from '../../../../shared/validation/bounded-decimal';
import {
  AGREEMENT_PERCENT_BY_CATEGORY_MESSAGE,
  CATEGORY_KEY_MAX,
  PERCENT_BY_CATEGORY_MAX_KEYS,
  PERCENT_MAX,
  PERCENT_MIN,
} from '../../domain/agreement-rules';

/**
 * `{ "<categoría>": <porcentaje> }`: objeto plano, como mucho
 * `PERCENT_BY_CATEGORY_MAX_KEYS` claves no vacías (sin contar espacios) de
 * hasta `CATEGORY_KEY_MAX` caracteres, y valores numéricos de 0 a 100 con
 * hasta 2 decimales. Que la categoría exista en el catálogo lo comprueba el
 * caso de uso, que es quien lo lee.
 */
export function isPercentByCategory(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length > PERCENT_BY_CATEGORY_MAX_KEYS) return false;
  return entries.every(
    ([key, percent]) =>
      key.trim().length > 0 &&
      key.length <= CATEGORY_KEY_MAX &&
      typeof percent === 'number' &&
      Number.isFinite(percent) &&
      percent >= PERCENT_MIN &&
      percent <= PERCENT_MAX &&
      decimalPlaces(percent) <= 2,
  );
}

export function IsPercentByCategory(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isPercentByCategory',
      validator: {
        validate: isPercentByCategory,
        defaultMessage: () => AGREEMENT_PERCENT_BY_CATEGORY_MESSAGE,
      },
    },
    validationOptions,
  );
}
