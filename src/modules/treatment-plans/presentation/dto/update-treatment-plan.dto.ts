import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { TreatmentPlanStatus } from '@prisma/client';
import { OPTION_LABEL_MAX } from '../../domain/plan-options';

// All fields optional (partial update: change status and/or notes and/or
// currency). NO `tenantId` field — same rationale as UpdateAppointmentDto.
// `currency` is validated against the seeded `currencies` table by
// UpdateTreatmentPlanUseCase ONLY when provided — an omitted `currency`
// leaves the plan's existing currency untouched.
export class UpdateTreatmentPlanDto {
  @ApiPropertyOptional({
    enum: TreatmentPlanStatus,
    description:
      'Sigue la máquina de estados (DX-040; 409 si la transición no existe). PRESENTED y REJECTED tienen su propia acción (400 aquí); ACCEPTED solo DENTIST y ADMIN (403)',
  })
  @IsOptional()
  @IsEnum(TreatmentPlanStatus, { message: 'Estado de plan no válido.' })
  status?: TreatmentPlanStatus;

  @ApiPropertyOptional({ description: 'Código ISO 4217 de 3 letras.' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({
    maxLength: OPTION_LABEL_MAX,
    example: 'Opción A: implante',
    description: 'Etiqueta de la opción (DX-040); vacía la quita',
  })
  @IsOptional()
  @IsString({ message: 'La etiqueta de la opción debe ser un texto.' })
  @MaxLength(OPTION_LABEL_MAX, {
    message: `La etiqueta de la opción admite hasta ${OPTION_LABEL_MAX} caracteres.`,
  })
  optionLabel?: string;
}
