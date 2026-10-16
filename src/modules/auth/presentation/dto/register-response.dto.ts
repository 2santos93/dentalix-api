import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

// DX-029 (SEC-006/SEC-007): POST /auth/register ya NO crea la clínica ni
// devuelve identificadores. Responde siempre 202 con este mismo cuerpo, exista
// o no el email, y la clínica se crea al abrir el enlace del email
// (POST /auth/register/verify).
export class RegisterAcceptedDto {
  @ApiProperty({
    example:
      'Te enviamos un correo para confirmar el registro. Abre el enlace para activar tu clínica.',
  })
  message!: string;
}

export class VerifyRegistrationDto {
  @ApiProperty({ description: 'Token del enlace del email de verificación' })
  @IsString()
  @MaxLength(128)
  token!: string;
}

// Respuesta de POST /auth/register/verify: la clínica y su dueño ya existen
// (email verificado). No abre sesión: el siguiente paso es iniciar sesión en
// el host de la clínica (`subdomain`).
export class RegisterVerifiedDto {
  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ description: 'Subdominio de la clínica recién creada' })
  subdomain!: string;
}
