import { BadRequestException } from '@nestjs/common';

/**
 * DX-374: la clínica usa tasa MANUAL y no registró la de esa moneda para ese
 * día. Se trata como «sin tasa» (igual que una moneda sin tasa del
 * proveedor): el saldo y los totales la excluyen y nunca se pide al
 * proveedor. Por la ruta de conversión sale como 400 en español.
 */
export class MissingExchangeRateError extends BadRequestException {
  constructor(
    readonly currency: string,
    readonly date: string,
  ) {
    super({
      statusCode: 400,
      error: 'Bad Request',
      code: 'EXCHANGE_RATE_MISSING',
      message: `No hay tasa de ${currency} para el día ${date}: la clínica usa tasa manual y aún no la registró. Regístrala en Ajustes › Tasa de cambio.`,
    });
    this.name = 'MissingExchangeRateError';
  }
}

/**
 * ¿Es «sin tasa» de una moneda? La moneda no tiene tasa ese día: la tasa
 * manual que falta (DX-374) o la que el proveedor no trae (`unsupported
 * currency`, el texto de `ConvertAmountUseCase`). Cualquier otro error es un
 * fallo real y quien llama lo propaga.
 */
export function isMissingRateError(error: unknown): boolean {
  if (error instanceof MissingExchangeRateError) return true;
  return (
    error instanceof BadRequestException &&
    typeof error.message === 'string' &&
    error.message.startsWith('unsupported currency')
  );
}
