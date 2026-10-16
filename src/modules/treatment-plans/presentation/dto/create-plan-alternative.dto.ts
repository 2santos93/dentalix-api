import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { OPTION_LABEL_MAX } from '../../domain/plan-options';

// Cuerpo de POST /treatment-plans/:id/alternatives (DX-040). El paciente, la
// moneda y los ítems salen del plan de origen; el autor, del token.
export class CreatePlanAlternativeDto {
  @ApiPropertyOptional({
    maxLength: OPTION_LABEL_MAX,
    example: 'Opción B: puente',
    description: 'Por defecto, la letra siguiente del grupo («Opción B»…)',
  })
  @IsOptional()
  @IsString({ message: 'La etiqueta de la opción debe ser un texto.' })
  @MaxLength(OPTION_LABEL_MAX, {
    message: `La etiqueta de la opción admite hasta ${OPTION_LABEL_MAX} caracteres.`,
  })
  optionLabel?: string;
}
