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
      'Registro profesional (CO) / nº de colegiado (ES) si tu perfil aún no lo tiene; queda guardado en la receta y en tu perfil de la clínica. Si el perfil ya lo tiene, se ignora (lo cambia un ADMIN en Personal).',
  })
  @IsOptional()
  @IsString({ message: 'El registro profesional debe ser un texto' })
  @MaxLength(60, {
    message: 'El registro profesional admite como mucho 60 caracteres',
  })
  professionalLicense?: string;

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'Clientes anteriores a DX-300: confirmación ante una alerta de alergia. Cuenta como `safetyOverride`; el motivo sigue siendo obligatorio.',
  })
  @IsOptional()
  @IsBoolean({ message: 'allergyOverride debe ser verdadero o falso' })
  allergyOverride?: boolean;

  @ApiPropertyOptional({
    description:
      'DX-300: confirmación explícita de los avisos bloqueantes (alergia, interacción, embarazo, dosis infantil). Sin ella, o sin `safetyOverrideReason`, la API responde 409 con los avisos.',
  })
  @IsOptional()
  @IsBoolean({ message: 'safetyOverride debe ser verdadero o falso' })
  safetyOverride?: boolean;

  @ApiPropertyOptional({
    maxLength: 500,
    example: 'INR estable; pauta corta acordada con hematología',
    description:
      'DX-300: motivo de la confirmación. Queda en la receta (dentro del hash). Se ignora si no hay avisos bloqueantes.',
  })
  @IsOptional()
  @IsString({ message: 'El motivo debe ser un texto' })
  @MaxLength(500, { message: 'El motivo admite como mucho 500 caracteres' })
  safetyOverrideReason?: string;
}

const CHECK_TEXT_MAX = 200;
const checkText = (field: string) => ({
  message: `${field} debe ser un texto de como mucho ${CHECK_TEXT_MAX} caracteres`,
});

/** Lo que la previsualización de avisos necesita de cada medicamento. */
export class SafetyCheckItemDto {
  @ApiProperty({ maxLength: CHECK_TEXT_MAX, example: 'Ibuprofeno' })
  @IsString(checkText('El principio activo'))
  @MaxLength(CHECK_TEXT_MAX, checkText('El principio activo'))
  activeIngredient!: string;

  @ApiPropertyOptional({ maxLength: CHECK_TEXT_MAX, example: '400 mg' })
  @IsOptional()
  @IsString(checkText('La concentración'))
  @MaxLength(CHECK_TEXT_MAX, checkText('La concentración'))
  concentration?: string;

  @ApiPropertyOptional({ maxLength: CHECK_TEXT_MAX, example: '1 comprimido' })
  @IsOptional()
  @IsString(checkText('La dosis'))
  @MaxLength(CHECK_TEXT_MAX, checkText('La dosis'))
  dose?: string;

  @ApiPropertyOptional({ maxLength: CHECK_TEXT_MAX, example: 'Cada 8 horas' })
  @IsOptional()
  @IsString(checkText('La frecuencia'))
  @MaxLength(CHECK_TEXT_MAX, checkText('La frecuencia'))
  frequency?: string;
}

export class PrescriptionSafetyCheckDto {
  @ApiProperty({ type: [SafetyCheckItemDto], description: '0 a 10' })
  @IsArray({ message: 'Los medicamentos deben ser una lista' })
  @ArrayMaxSize(10, { message: 'Una receta admite como mucho 10 medicamentos' })
  @ValidateNested({ each: true })
  @Type(() => SafetyCheckItemDto)
  items!: SafetyCheckItemDto[];
}

export class VoidPrescriptionDto {
  @ApiProperty({ minLength: 1, maxLength: 500, example: 'Dosis equivocada' })
  @IsString({ message: 'El motivo de la anulación es obligatorio' })
  @MaxLength(500, { message: 'El motivo admite como mucho 500 caracteres' })
  reason!: string;
}
