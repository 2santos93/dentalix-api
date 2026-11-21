import { BadRequestException } from '@nestjs/common';

/**
 * DX-111 (BE-005): «esa moneda no tiene tasa ese día», con sus dos causas
 * tipadas. Quien la trata como «sin tasa» (el saldo y los totales la
 * excluyen) lo decide por el TIPO, nunca por el texto del mensaje.
 */
export abstract class ExchangeRateUnavailableError extends BadRequestException {
  protected constructor(
    readonly currency: string,
    readonly date: string,
    code: string,
    message: string,
  ) {
    super({ statusCode: 400, error: 'Bad Request', code, message });
  }
}

/**
 * DX-374: la clínica usa tasa MANUAL y no registró la de esa moneda para ese
 * día. Se trata como «sin tasa» (igual que una moneda sin tasa del
 * proveedor): el saldo y los totales la excluyen y nunca se pide al
 * proveedor. Por la ruta de conversión sale como 400 en español.
 */
export class MissingExchangeRateError extends ExchangeRateUnavailableError {
  constructor(currency: string, date: string) {
    super(
      currency,
      date,
      'EXCHANGE_RATE_MISSING',
      `No hay tasa de ${currency} para el día ${date}: la clínica usa tasa manual y aún no la registró. Regístrala en Ajustes › Tasa de cambio.`,
    );
    this.name = 'MissingExchangeRateError';
  }
}

/**
 * La tasa automática (del proveedor) no trae esa moneda ese día. Antes era un
 * `BadRequestException('unsupported currency: X')` reconocido por su texto.
 */
export class UnsupportedCurrencyRateError extends ExchangeRateUnavailableError {
  constructor(currency: string, date: string) {
    super(
      currency,
      date,
      'EXCHANGE_RATE_UNSUPPORTED',
      `El proveedor de tasas no publica la tasa de ${currency} para el día ${date}. Puedes registrarla a mano en Ajustes › Tasa de cambio.`,
    );
    this.name = 'UnsupportedCurrencyRateError';
  }
}

/**
 * DX-585: la clínica usa la tasa del BCV y no hay tasa del BCV guardada que
 * rija ese día (el BCV no la publicó aún o no se pudo consultar). Es «sin
 * tasa», como las otras dos: el abono la toma cuando llegue (barrido de
 * reintentos, DX-380).
 */
export class MissingBcvRateError extends ExchangeRateUnavailableError {
  constructor(currency: string, date: string) {
    super(
      currency,
      date,
      'EXCHANGE_RATE_BCV_MISSING',
      `No hay tasa del BCV de ${currency} para el día ${date}: aún no se publicó o no se pudo consultar. Se toma sola en cuanto llegue.`,
    );
    this.name = 'MissingBcvRateError';
  }
}

/**
 * ¿Es «sin tasa» de una moneda? La tasa manual que falta (DX-374) o la que el
 * proveedor no trae. Cualquier otro error es un fallo real y quien llama lo
 * propaga.
 */
export function isMissingRateError(error: unknown): boolean {
  return error instanceof ExchangeRateUnavailableError;
}
