import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';

export class PlatformMfaStatusDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  enabledAt!: Date | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'SEC-008: desde cuándo sirve para el acceso de soporte (alta + espera de seguridad, BREAK_GLASS_MFA_COOLDOWN_MINUTES). null sin MFA.',
  })
  breakGlassAvailableAt!: Date | null;
}

export class PlatformMfaEnrollmentDto {
  @ApiProperty({
    example: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    description:
      'Secreto TOTP en base32 para teclearlo en la app de autenticación. Solo se muestra en esta respuesta.',
  })
  secret!: string;

  @ApiProperty({
    example:
      'otpauth://totp/Dentalix:soporte%40dentalix.app?secret=JBSWY3DPEHPK3PXP&issuer=Dentalix&algorithm=SHA1&digits=6&period=30',
  })
  otpauthUri!: string;
}

export class ConfirmPlatformMfaDto {
  @ApiProperty({
    example: '123456',
    description: 'Código de 6 dígitos de la app',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s/g, '') : value,
  )
  @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos.' })
  code!: string;
}
