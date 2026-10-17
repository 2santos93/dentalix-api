import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { DiscountReasonFieldsDto } from './discount-reason.dto';

export const BULK_DISCOUNT_MAX_ITEMS = 100;

/** Acción «Descuento %» sobre varios ítems del plan (DX-204). */
export class ApplyBulkDiscountDto extends DiscountReasonFieldsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: BULK_DISCOUNT_MAX_ITEMS,
    description:
      'Ítems vivos de ESTE plan (404 si alguno no lo es: nada cambia)',
  })
  @IsArray({ message: 'Selecciona al menos un ítem.' })
  @ArrayMinSize(1, { message: 'Selecciona al menos un ítem.' })
  @ArrayMaxSize(BULK_DISCOUNT_MAX_ITEMS, {
    message: `Selecciona como mucho ${BULK_DISCOUNT_MAX_ITEMS} ítems.`,
  })
  @IsUUID('all', { each: true, message: 'Cada ítem debe ser un UUID.' })
  itemIds!: string[];

  @ApiProperty({
    minimum: 0,
    maximum: 100,
    example: 7.5,
    description:
      '% del precio de cada ítem (hasta 2 decimales; 0 quita el descuento). Por encima del tope del rol: 403',
  })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'El porcentaje debe ser un número con hasta 2 decimales.' },
  )
  @Min(0, { message: 'El porcentaje no puede ser negativo.' })
  @Max(100, { message: 'El porcentaje no puede pasar del 100 %.' })
  percent!: number;
}
