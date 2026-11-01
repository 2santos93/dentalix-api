import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength } from 'class-validator';
import { SecondFactorDto } from '../../../auth/presentation/dto/login-mfa.dto';

export class MyMfaStatusDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  enabledAt!: Date | null;
  @ApiProperty({ description: 'Códigos de recuperación sin usar (0 sin MFA).' })
  recoveryCodesRemaining!: number;
  @ApiProperty({
    description:
      'Obligatorio para ti en esta clínica (cuenta de soporte de Dentalix, o ADMIN de una clínica que lo exige): no se puede desactivar.',
  })
  required!: boolean;
}

export class StartMyMfaDto {
  @ApiProperty({ description: 'Contraseña actual (re-autenticación).' })
  @IsString()
  @MaxLength(256)
  currentPassword!: string;
}

export class ConfirmMyMfaDto {
  @ApiProperty({ example: '123456' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s/g, '') : value,
  )
  @Matches(/^\d{6}$/, { message: 'El código debe tener 6 dígitos.' })
  code!: string;
}

/** Contraseña actual + segundo factor (código de la app o de recuperación). */
export class ReauthMfaDto extends SecondFactorDto {
  @ApiProperty({ description: 'Contraseña actual (re-autenticación).' })
  @IsString()
  @MaxLength(256)
  currentPassword!: string;
}

export class RecoveryCodesDto {
  @ApiProperty({
    type: [String],
    description:
      '10 códigos de un solo uso. Solo se muestran en esta respuesta.',
  })
  recoveryCodes!: string[];
}

/** Alta confirmada: estado, códigos (una vez) y la sesión NUEVA de este dispositivo. */
export class MyMfaEnabledDto extends MyMfaStatusDto {
  @ApiProperty({ type: [String] })
  recoveryCodes!: string[];

  @ApiProperty({
    description:
      'Access token nuevo: activar el MFA cierra tus demás sesiones (tokenVersion + 1). En modo cookie el refresh nuevo llega en la cookie.',
  })
  accessToken!: string;

  @ApiPropertyOptional() refreshToken?: string;
}
