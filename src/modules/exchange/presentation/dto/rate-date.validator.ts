import { ValidateBy } from 'class-validator';
import {
  isValidRateDate,
  RATE_DATE_INVALID_MESSAGE,
} from '../../application/use-cases/get-rates-for-date.use-case';

/**
 * BE-049 / SEC-054: un día civil AAAA-MM-DD que existe. `2026-02-30` ya no
 * pasa como el 2 de marzo ni `2026-13-01` acaba en 500. La ventana de días
 * que se pueden pedir al proveedor la comprueba el caso de uso.
 */
export function IsRateDate(): PropertyDecorator {
  return ValidateBy({
    name: 'isRateDate',
    validator: {
      validate: isValidRateDate,
      defaultMessage: () => RATE_DATE_INVALID_MESSAGE,
    },
  });
}

/** Descripción común del parámetro `date` de las rutas de tasas. */
export const RATE_DATE_DESCRIPTION =
  'Día de la tasa (AAAA-MM-DD, un día que exista). Un día ya guardado se sirve siempre; uno sin guardar solo se pide al proveedor entre el alta de la clínica (o su primer abono, lo anterior) y hoy en la zona de sus sedes: fuera de ahí, 400 `EXCHANGE_RATE_DATE_OUT_OF_RANGE`.';
