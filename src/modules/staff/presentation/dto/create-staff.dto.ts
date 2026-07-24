import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsString, MinLength } from 'class-validator';
import { ClinicRole } from '@prisma/client';

export class CreateStaffDto {
  @ApiProperty() @IsString() @MinLength(2) fullName!: string;
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty({ enum: ClinicRole }) @IsEnum(ClinicRole) role!: ClinicRole;
  @ApiProperty({ minLength: 8 }) @IsString() @MinLength(8) password!: string;
}
