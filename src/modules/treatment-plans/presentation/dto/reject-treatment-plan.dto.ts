import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { TreatmentPlanRejectionReason } from '@prisma/client';
import { REJECTION_NOTE_MAX } from '../../domain/plan-options';

// Cuerpo de POST /treatment-plans/:id/reject (DX-040). Quién y cuándo salen
// del token y del reloj del servidor, nunca del cliente.
export class RejectTreatmentPlanDto {
  @ApiProperty({
    enum: TreatmentPlanRejectionReason,
    enumName: 'TreatmentPlanRejectionReason',
    description:
      'Motivo del catálogo. OTHER_OPTION_ACCEPTED lo pone el sistema al aceptar otra opción del grupo (400 si lo envía el cliente); OTHER exige `note`',
  })
  @IsEnum(TreatmentPlanRejectionReason, {
    message:
      'Elige el motivo del rechazo: precio, miedo, segunda opinión u otro.',
  })
  reason!: TreatmentPlanRejectionReason;

  @ApiPropertyOptional({
    maxLength: REJECTION_NOTE_MAX,
    example: 'Prefiere esperar a la prima de diciembre',
  })
  @IsOptional()
  @IsString({ message: 'La nota del rechazo debe ser un texto.' })
  @MaxLength(REJECTION_NOTE_MAX, {
    message: `La nota del rechazo admite hasta ${REJECTION_NOTE_MAX} caracteres.`,
  })
  note?: string;
}
