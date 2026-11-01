import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsString,
  ValidateNested,
} from 'class-validator';
import {
  CURRENCY_TEXT_MAX,
  CURRENCY_TEXTS_MAX_ENTRIES,
} from '../../../../shared/format/currency-text';
import { CURRENCY_TEXTS_TOO_MANY_MESSAGE } from '../../domain/clinic-currency-texts';

/** DX-517: una moneda y el texto con el que la clínica la escribe. */
export class CurrencyTextEntryDto {
  @ApiProperty({
    description: 'Código ISO 4217 de una moneda del catálogo.',
  })
  @IsString({ message: 'La moneda debe ser un código ISO de tres letras.' })
  currency!: string;

  @ApiProperty({
    maxLength: CURRENCY_TEXT_MAX,
    description: `Texto que sustituye al código en los importes: 1 a ${CURRENCY_TEXT_MAX} caracteres en una línea (se recorta).`,
  })
  @IsString({ message: 'El texto de la moneda debe ser un texto.' })
  text!: string;
}

/** DX-517: `GET`/`PUT /exchange/currency-texts`. */
export class ClinicCurrencyTextsDto {
  @ApiProperty({
    type: [CurrencyTextEntryDto],
    maxItems: CURRENCY_TEXTS_MAX_ENTRIES,
    description:
      'El mapa entero, en orden de código. Vacío = nada configurado: los importes llevan el código ISO (DX-378).',
  })
  @IsArray({ message: 'Las monedas deben ir en una lista.' })
  @ArrayMaxSize(CURRENCY_TEXTS_MAX_ENTRIES, {
    message: CURRENCY_TEXTS_TOO_MANY_MESSAGE,
  })
  @ValidateNested({ each: true })
  @Type(() => CurrencyTextEntryDto)
  entries!: CurrencyTextEntryDto[];
}
