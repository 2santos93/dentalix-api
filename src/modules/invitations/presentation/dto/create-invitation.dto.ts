import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ClinicRole } from '@prisma/client';

export class CreateInvitationDto {
  // Topes de longitud (DX-088, revisión D5): ambos llegan al email.
  @ApiProperty({ minLength: 2, maxLength: 120 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName!: string;

  @ApiProperty({ maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  email!: string;
  @ApiProperty({ enum: ClinicRole }) @IsEnum(ClinicRole) role!: ClinicRole;
}
