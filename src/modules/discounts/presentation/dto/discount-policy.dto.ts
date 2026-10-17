import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsInt,
  IsObject,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const PERCENT_MESSAGE =
  'Cada porcentaje debe ser un número entero entre 0 y 100.';

function percent(description: string) {
  return ApiProperty({ minimum: 0, maximum: 100, type: Number, description });
}

/** % máximo de descuento por ítem según el rol de quien lo da (DX-204). */
export class DiscountMaxPercentByRoleDto {
  @percent('Administración (por defecto 100)')
  @IsInt({ message: PERCENT_MESSAGE })
  @Min(0, { message: PERCENT_MESSAGE })
  @Max(100, { message: PERCENT_MESSAGE })
  ADMIN!: number;

  @percent('Odontólogo (por defecto 10)')
  @IsInt({ message: PERCENT_MESSAGE })
  @Min(0, { message: PERCENT_MESSAGE })
  @Max(100, { message: PERCENT_MESSAGE })
  DENTIST!: number;

  @percent('Asistente (por defecto 0)')
  @IsInt({ message: PERCENT_MESSAGE })
  @Min(0, { message: PERCENT_MESSAGE })
  @Max(100, { message: PERCENT_MESSAGE })
  ASSISTANT!: number;

  @percent('Recepción (por defecto 0; hoy no edita ítems de plan)')
  @IsInt({ message: PERCENT_MESSAGE })
  @Min(0, { message: PERCENT_MESSAGE })
  @Max(100, { message: PERCENT_MESSAGE })
  RECEPTION!: number;
}

export class UpdateDiscountPolicyDto {
  @ApiProperty({ type: DiscountMaxPercentByRoleDto })
  @IsDefined({ message: 'Indica el tope de cada rol.' })
  @IsObject({ message: 'Indica el tope de cada rol.' })
  @ValidateNested()
  @Type(() => DiscountMaxPercentByRoleDto)
  maxPercentByRole!: DiscountMaxPercentByRoleDto;

  @ApiProperty({
    minimum: 0,
    maximum: 100,
    description:
      'Por ENCIMA de este % (estrictamente) el motivo del descuento es obligatorio (por defecto 10)',
  })
  @IsInt({
    message: 'El umbral del motivo debe ser un número entero entre 0 y 100.',
  })
  @Min(0, {
    message: 'El umbral del motivo debe ser un número entero entre 0 y 100.',
  })
  @Max(100, {
    message: 'El umbral del motivo debe ser un número entero entre 0 y 100.',
  })
  reasonRequiredAbovePercent!: number;
}

export class DiscountPolicyDto {
  @ApiProperty({ type: DiscountMaxPercentByRoleDto })
  maxPercentByRole!: DiscountMaxPercentByRoleDto;

  @ApiProperty({ minimum: 0, maximum: 100 })
  reasonRequiredAbovePercent!: number;

  @ApiProperty({
    description: 'true = la clínica nunca la cambió (valores por defecto)',
  })
  isDefault!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  updatedAt!: Date | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  updatedById!: string | null;
}
