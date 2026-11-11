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
      'VALID: se puede usar. EXPIRED: caducó (30 min). USED: ya se usó. INVALID: no existe, fue reemplazado por uno más reciente, quedó invalidado por un cambio de contraseña o no vale en esta clínica.',
  })
  status!: (typeof PASSWORD_RESET_TOKEN_STATUSES)[number];
}

/**
 * DX-114 R4: cuerpo del 404 de POST /auth/reset-password. `code` es estable;
 * `message` es el texto para la persona.
 */
export class ResetTokenNotFoundErrorDto {
  @ApiProperty({ example: 404 })
  statusCode!: number;

  @ApiProperty({ example: 'Not Found' })
  error!: string;

  @ApiProperty({
    enum: ['RESET_TOKEN_INVALID'],
    example: 'RESET_TOKEN_INVALID',
  })
  code!: 'RESET_TOKEN_INVALID';

  @ApiProperty({
    example:
      'El enlace para restablecer la contraseña no es válido o ya fue reemplazado por uno más reciente. Pide un enlace nuevo.',
  })
  message!: string;
}

/** DX-114 R4: cuerpo del 410 de POST /auth/reset-password. */
export class ResetTokenGoneErrorDto {
  @ApiProperty({ example: 410 })
  statusCode!: number;

  @ApiProperty({ example: 'Gone' })
  error!: string;

  @ApiProperty({
    enum: ['RESET_TOKEN_EXPIRED', 'RESET_TOKEN_USED'],
    enumName: 'ResetTokenGoneCode',
    description:
      'RESET_TOKEN_EXPIRED: caducó (30 min). RESET_TOKEN_USED: ya se usó.',
  })
  code!: 'RESET_TOKEN_EXPIRED' | 'RESET_TOKEN_USED';

  @ApiProperty({
    example:
      'El enlace para restablecer la contraseña caducó (vale 30 minutos). Pide un enlace nuevo.',
  })
  message!: string;
}
