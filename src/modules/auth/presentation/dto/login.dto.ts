import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import {
  BREAK_GLASS_REASON_MAX,
  BREAK_GLASS_REASON_MIN,
} from '../../domain/break-glass';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class LoginDto {
  @ApiProperty({ example: 'ana@clinica.com' })
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  password!: string;

  @ApiPropertyOptional({
    description:
      'SEC-008: código TOTP de 6 dígitos. Solo para el acceso de soporte (break-glass) de un superadmin a una clínica en la que no es miembro; en cualquier otro login se ignora.',
    example: '123456',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos.' })
  mfaCode?: string;

  @ApiPropertyOptional({
    description: `SEC-008: motivo del acceso de soporte (${BREAK_GLASS_REASON_MIN}–${BREAK_GLASS_REASON_MAX} caracteres). La clínica lo ve en «Accesos de soporte».`,
    minLength: BREAK_GLASS_REASON_MIN,
    maxLength: BREAK_GLASS_REASON_MAX,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(BREAK_GLASS_REASON_MIN, BREAK_GLASS_REASON_MAX, {
    message: `El motivo debe tener entre ${BREAK_GLASS_REASON_MIN} y ${BREAK_GLASS_REASON_MAX} caracteres.`,
  })
  breakGlassReason?: string;
}
