import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/**
 * DX-137: una sesión abierta (un inicio de sesión en un navegador). Solo lo
 * resumido: navegador y sistema, y la red (IP truncada /24 o /48). Nunca el
 * user-agent ni la IP completos.
 */
export class UserSessionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Chrome en Windows' }) deviceLabel!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '190.202.15.0/24',
    description:
      'IP truncada (/24 en IPv4, /48 en IPv6). Nunca la IP completa.',
  })
  ipPrefix!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Inicio de sesión',
  })
  firstSeenAt!: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Última renovación de la sesión (actividad)',
  })
  lastSeenAt!: Date;
  @ApiProperty({
    description: 'Es la sesión de esta petición («este dispositivo»)',
  })
  current!: boolean;
}

export class SessionsClosedDto {
  @ApiProperty({ minimum: 0 }) sessionsClosed!: number;
}

export class NotMeDto {
  @ApiProperty({ description: 'Token del enlace «No fui yo» del email' })
  @IsString()
  @MaxLength(128)
  token!: string;
}

export class NotMeResultDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Token del enlace de restablecimiento (`/restablecer/<token>`) para cambiar la contraseña ya. `null` si la cuenta ya no es miembro activo de esta clínica (las sesiones se cerraron igual).',
  })
  passwordResetToken!: string | null;
}
