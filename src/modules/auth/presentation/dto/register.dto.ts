import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * DX-144 (SEC-034): tope de lo que escribe quien pide el alta, como en las
 * invitaciones (`CreateInvitationDto`). El alta es pública y su email sale a
 * cualquier dirección: nada de párrafos libres.
 */
export const REGISTER_TEXT_MAX_LENGTH = 120;

export class RegisterDto {
  @ApiProperty({ minLength: 2, maxLength: REGISTER_TEXT_MAX_LENGTH })
  @IsString()
  @MinLength(2, {
    message: 'El nombre de la clínica debe tener al menos 2 caracteres',
  })
  @MaxLength(REGISTER_TEXT_MAX_LENGTH, {
    message: `El nombre de la clínica admite como mucho ${REGISTER_TEXT_MAX_LENGTH} caracteres`,
  })
  clinicName!: string;

  @ApiProperty({ pattern: '^[a-z0-9-]+$', example: 'sonrisa' })
  @Matches(/^[a-z0-9-]+$/, {
    message: 'subdomain must be lowercase alphanumeric or hyphen',
  })
  subdomain!: string;

  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 8, format: 'password' })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({ minLength: 2, maxLength: REGISTER_TEXT_MAX_LENGTH })
  @IsString()
  @MinLength(2, { message: 'Tu nombre debe tener al menos 2 caracteres' })
  @MaxLength(REGISTER_TEXT_MAX_LENGTH, {
    message: `Tu nombre admite como mucho ${REGISTER_TEXT_MAX_LENGTH} caracteres`,
  })
  fullName!: string;
}
