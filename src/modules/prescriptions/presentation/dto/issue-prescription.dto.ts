import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PrescriptionItemInputDto } from './prescription-item-input.dto';

// Sin `tenantId`, profesional, sede, `issuedAt` ni hash: los pone el servidor.
export class IssuePrescriptionDto {
  @ApiProperty({
    type: [PrescriptionItemInputDto],
    description: '1 a 10 (en ES, 1)',
  })
  @IsArray({ message: 'Los medicamentos deben ser una lista' })
  @ArrayMaxSize(10, { message: 'Una receta admite como mucho 10 medicamentos' })
  @ValidateNested({ each: true })
  @Type(() => PrescriptionItemInputDto)
  items!: PrescriptionItemInputDto[];

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-10-16',
    description:
      'Fecha prevista de dispensación (ES) / de la receta. Por defecto hoy en la zona de la sede; no anterior a hoy ni más de 90 días después.',
  })
  @IsOptional()
  @IsString({
    message: 'La fecha de dispensación debe tener el formato AAAA-MM-DD',
  })
  dispensationDate?: string;

  @ApiPropertyOptional({
    maxLength: 1000,
    description: 'Indicaciones generales',
  })
  @IsOptional()
  @IsString({ message: 'Las indicaciones deben ser un texto' })
  @MaxLength(1000, {
    message: 'Las indicaciones admiten como mucho 1000 caracteres',
  })
  notes?: string;

  @ApiPropertyOptional({
    maxLength: 60,
    description:
      'Registro profesional (CO) / nº de colegiado (ES) si tu perfil aún no lo tiene; queda guardado en la receta y en tu perfil de la clínica.',
  })
  @IsOptional()
  @IsString({ message: 'El registro profesional debe ser un texto' })
  @MaxLength(60, {
    message: 'El registro profesional admite como mucho 60 caracteres',
  })
  professionalLicense?: string;

  @ApiPropertyOptional({
    description:
      'Confirmación explícita del profesional ante una alerta de alergia. Sin ella, una coincidencia con la anamnesis da 409.',
  })
  @IsOptional()
  @IsBoolean({ message: 'allergyOverride debe ser verdadero o falso' })
  allergyOverride?: boolean;
}

export class VoidPrescriptionDto {
  @ApiProperty({ minLength: 1, maxLength: 500, example: 'Dosis equivocada' })
  @IsString({ message: 'El motivo de la anulación es obligatorio' })
  @MaxLength(500, { message: 'El motivo admite como mucho 500 caracteres' })
  reason!: string;
}
