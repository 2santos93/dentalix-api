import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH } from '../../../../shared/security/password-policy';

export class AcceptInvitationDto {
  @ApiProperty({ minLength: 8, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(8)
  @MaxLength(PASSWORD_MAX_LENGTH, {
    message: `La contraseña no puede tener más de ${PASSWORD_MAX_LENGTH} caracteres.`,
  })
  password!: string;
}
