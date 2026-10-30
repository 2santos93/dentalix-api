import { ValidateBy, type ValidationArguments } from 'class-validator';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';
import {
  isRateDateInRange,
  isValidRateDate,
  RATE_DATE_INVALID_MESSAGE,
  RATE_DATE_OUT_OF_RANGE_MESSAGE,
} from '../../application/use-cases/get-rates-for-date.use-case';

/**
 * BE-049 / SEC-054 / DX-383: un día civil AAAA-MM-DD que existe y cae en
 * `PERIOD_DAY_MIN`..`PERIOD_DAY_MAX`. `2026-02-30` ya no pasa como el 2 de
 * marzo, `2026-13-01` no acaba en 500 y `1900-01-01` o `2999-12-31` no llegan
 * a la consulta ni al proveedor. «No futuro en las sedes» y la ventana de
 * días que se pueden pedir al proveedor los comprueba el caso de uso.
 */
export function IsRateDate(): PropertyDecorator {
  return ValidateBy({
    name: 'isRateDate',
    validator: {
      validate: (value: unknown) =>
        isValidRateDate(value) && isRateDateInRange(value),
      defaultMessage: (args?: ValidationArguments) =>
        isValidRateDate(args?.value)
          ? RATE_DATE_OUT_OF_RANGE_MESSAGE
          : RATE_DATE_INVALID_MESSAGE,
    },
  });
}

/** Descripción común del parámetro `date` de las rutas de tasas. */
export const RATE_DATE_DESCRIPTION = `Día de la tasa (AAAA-MM-DD, un día que exista) entre el ${PERIOD_DAY_MIN} y el ${PERIOD_DAY_MAX}, y nunca posterior a hoy en la zona de las sedes de la clínica (la más adelantada): si no, 400 (\`EXCHANGE_RATE_DATE_FUTURE\` con \`today\` para un día futuro) sin leer tasas ni llamar al proveedor. Un día ya guardado se sirve siempre; uno sin guardar solo se pide al proveedor desde el alta de la clínica (o su primer abono, lo anterior): antes, 400 \`EXCHANGE_RATE_DATE_OUT_OF_RANGE\`.`;

/** Lo que Swagger publica del parámetro `date` (formato y rango). */
export const RATE_DATE_API_PROPERTY = {
  example: '2026-07-01',
  format: 'date',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: RATE_DATE_DESCRIPTION,
} as const;
