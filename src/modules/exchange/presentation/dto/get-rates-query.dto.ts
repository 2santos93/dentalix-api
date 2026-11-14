import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, Matches } from 'class-validator';
import { IsRateDate, RATE_DATE_API_PROPERTY } from './rate-date.validator';
import { currencyListMessage } from '../../../../shared/money/currency-messages';

export const RATE_CURRENCIES_MAX = 6;
export const RATE_CURRENCIES_MESSAGE = currencyListMessage(RATE_CURRENCIES_MAX);

/** `VES,eur` → `['VES', 'EUR']`; lo que no es texto pasa para que lo rechace el validador. */
function toCurrencyList({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value;
  return value
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code !== '');
}

export class GetRatesQueryDto {
  @ApiProperty(RATE_DATE_API_PROPERTY)
  @IsRateDate()
  date!: string;

  @ApiPropertyOptional({
    type: String,
    example: 'VES,EUR',
    description:
      'DX-384. Códigos ISO 4217 separados por comas de las monedas con que se va a convertir ese día (la del abono y la de su plan). Con fuente MANUAL y plazo de la clínica > 0, si alguna no tiene tasa registrada ese día se devuelven las tasas de la última fecha anterior, dentro del plazo, que las tiene todas (`rateDate`). Sin este parámetro solo se devuelven las tasas del día exacto.',
  })
  @IsOptional()
  @Transform(toCurrencyList)
  @IsArray({ message: RATE_CURRENCIES_MESSAGE })
  @ArrayMaxSize(RATE_CURRENCIES_MAX, { message: RATE_CURRENCIES_MESSAGE })
  @Matches(/^[A-Z]{3}$/, { each: true, message: RATE_CURRENCIES_MESSAGE })
  currencies?: string[];
}
