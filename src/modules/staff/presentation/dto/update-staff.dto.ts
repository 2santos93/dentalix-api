import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ClinicRole } from '@prisma/client';

export class UpdateStaffDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  fullName?: string;
  @ApiPropertyOptional({ enum: ClinicRole })
  @IsOptional()
  @IsEnum(ClinicRole)
  role?: ClinicRole;
  @ApiPropertyOptional({
    maxLength: 60,
    description:
      'Registro profesional (CO: RETHUS / tarjeta profesional) o nº de colegiado (ES). Cadena vacía lo borra. Lo exige la receta (DX-013).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  professionalLicense?: string;
}
