import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../../../shared/security/password-policy';

export class ForgotPasswordDto {
  @ApiProperty({ maxLength: 254, example: 'ana@clinica.com' })
  @IsEmail({}, { message: 'Escribe un correo electrónico válido.' })
  @MaxLength(254)
  email!: string;
}

/** Cuerpo idéntico exista o no la cuenta (sin enumeración de usuarios). */
export class ForgotPasswordResponseDto {
  @ApiProperty({
    example:
      'Si el correo pertenece a una cuenta de esta clínica, te enviamos un enlace para restablecer la contraseña.',
  })
  message!: string;
}

export class PasswordResetTokenDto {
  @ApiProperty({ description: 'Token del enlace recibido por email.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  token!: string;
}

export class ResetPasswordDto extends PasswordResetTokenDto {
  @ApiProperty({
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, {
    message: `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`,
  })
  @MaxLength(PASSWORD_MAX_LENGTH, {
    message: `La contraseña no puede tener más de ${PASSWORD_MAX_LENGTH} caracteres.`,
  })
  password!: string;
}

export const PASSWORD_RESET_TOKEN_STATUSES = [
  'VALID',
  'EXPIRED',
  'USED',
  'INVALID',
] as const;

export class PasswordResetTokenStatusDto {
  @ApiProperty({
    enum: PASSWORD_RESET_TOKEN_STATUSES,
    enumName: 'PasswordResetTokenStatus',
    description:
      'VALID: se puede usar. EXPIRED: caducó (30 min). USED: ya se usó. INVALID: no existe, fue reemplazado por uno más reciente o no vale en esta clínica.',
  })
  status!: (typeof PASSWORD_RESET_TOKEN_STATUSES)[number];
}
