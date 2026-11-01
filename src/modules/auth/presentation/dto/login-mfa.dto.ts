import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const stripSpaces = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.replace(/\s/g, '') : value;

/** DX-021: respuesta del login cuando falta el segundo factor. */
export class MfaChallengeDto {
  @ApiProperty({
    enum: ['MFA_REQUIRED', 'MFA_ENROLLMENT_REQUIRED'],
    description:
      '`MFA_REQUIRED`: pide el código de la app (o uno de recuperación) en POST /auth/login/mfa. `MFA_ENROLLMENT_REQUIRED`: la clínica (o la cuenta de soporte) exige la verificación y aún no está activa: alta forzada en /auth/login/mfa/enrollment.',
  })
  mfa!: 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED';

  @ApiProperty({
    description:
      'Token intermedio de un solo uso (5 min; 10 en el alta). No da acceso a ninguna ruta de datos.',
  })
  mfaToken!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}

/** Un segundo factor: `code` (6 dígitos de la app) o `recoveryCode`, uno de los dos. */
export class SecondFactorDto {
  @ApiPropertyOptional({
    example: '123456',
    description: 'Código de 6 dígitos de la app.',
  })
  @ValidateIf((o: SecondFactorDto) => o.recoveryCode === undefined)
  @Transform(stripSpaces)
  @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos.' })
  code?: string;

  @ApiPropertyOptional({
    example: 'ABCD-EFGH-IJKL-MNOP',
    description:
      'Uno de los códigos de recuperación (cada uno vale una sola vez).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  recoveryCode?: string;
}

export class VerifyLoginMfaDto extends SecondFactorDto {
  @ApiProperty({ description: 'El `mfaToken` que devolvió POST /auth/login.' })
  @IsString()
  @Length(1, 2048)
  mfaToken!: string;
}

export class StartLoginMfaEnrollmentDto {
  @ApiProperty({
    description: 'El `mfaToken` (MFA_ENROLLMENT_REQUIRED) del login.',
  })
  @IsString()
  @Length(1, 2048)
  mfaToken!: string;
}

export class ConfirmLoginMfaEnrollmentDto extends StartLoginMfaEnrollmentDto {
  @ApiProperty({ example: '123456' })
  @Transform(stripSpaces)
  @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos.' })
  code!: string;
}

/** Alta: secreto (se muestra UNA vez) y `otpauth://` para el QR. */
export class MfaEnrollmentDto {
  @ApiProperty({
    example: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    description:
      'Secreto en base32 para escribirlo a mano en la app. Solo en esta respuesta.',
  })
  secret!: string;

  @ApiProperty({
    example:
      'otpauth://totp/Dentalix:ana%40clinica.com?secret=JBSWY3DPEHPK3PXP&issuer=Dentalix&algorithm=SHA1&digits=6&period=30',
  })
  otpauthUri!: string;
}

/** Fin del alta forzada: la sesión y los códigos de recuperación (una sola vez). */
export class MfaEnrolledSessionDto {
  @ApiProperty() accessToken!: string;

  @ApiPropertyOptional({
    description: 'Solo sin `X-Refresh-Transport: cookie` (ver AuthTokensDto).',
  })
  refreshToken?: string;

  @ApiProperty({
    type: [String],
    description:
      '10 códigos de recuperación de un solo uso. No se vuelven a mostrar.',
  })
  recoveryCodes!: string[];
}
