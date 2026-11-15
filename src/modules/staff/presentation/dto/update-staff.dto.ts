import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  INPUT_NAME_MAX,
  TextMaxLength,
} from '../../../../shared/validation/input-limits';
import { ClinicRole } from '@prisma/client';

export class UpdateStaffDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @TextMaxLength(INPUT_NAME_MAX)
  fullName?: string;
  @ApiPropertyOptional({ enum: ClinicRole })
  @IsOptional()
  @IsEnum(ClinicRole)
  role?: ClinicRole;
  @ApiPropertyOptional({
    maxLength: 60,
    description:
      'Nº de registro profesional del miembro. Cadena vacía lo borra. Lo exige la receta (DX-013).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  professionalLicense?: string;
  @ApiPropertyOptional({
    maxLength: 80,
    description:
      'Especialidad del profesional en esta clínica; la receta la imprime si existe. Cadena vacía la borra.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  professionalSpecialty?: string;
}
