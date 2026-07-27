import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
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
}
