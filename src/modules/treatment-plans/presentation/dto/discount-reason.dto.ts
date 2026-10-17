import { ApiPropertyOptional } from '@nestjs/swagger';
import { DiscountReason } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DISCOUNT_REASON_NOTE_MAX } from '../../../discounts/domain/discount-policy';

export const DISCOUNT_REASON_DESCRIPTION =
  'DX-204: motivo del descuento (catálogo corto). Obligatorio por encima del umbral de la política (422 si falta); OTHER exige nota';
export const DISCOUNT_REASON_NOTE_DESCRIPTION = `DX-204: nota del motivo (hasta ${DISCOUNT_REASON_NOTE_MAX} caracteres; obligatoria con OTHER). No sale en la auditoría`;

/** Motivo y nota de un descuento (DX-204), comunes a alta, edición y bloque. */
export class DiscountReasonFieldsDto {
  @ApiPropertyOptional({
    enum: DiscountReason,
    description: DISCOUNT_REASON_DESCRIPTION,
  })
  @IsOptional()
  @IsEnum(DiscountReason, { message: 'El motivo del descuento no es válido.' })
  discountReason?: DiscountReason;

  @ApiPropertyOptional({
    maxLength: DISCOUNT_REASON_NOTE_MAX,
    description: DISCOUNT_REASON_NOTE_DESCRIPTION,
  })
  @IsOptional()
  @IsString({ message: 'La nota del motivo debe ser texto.' })
  @MaxLength(DISCOUNT_REASON_NOTE_MAX, {
    message: `La nota del motivo admite hasta ${DISCOUNT_REASON_NOTE_MAX} caracteres.`,
  })
  discountReasonNote?: string;
}
