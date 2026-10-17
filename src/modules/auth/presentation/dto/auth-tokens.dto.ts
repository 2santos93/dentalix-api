import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Par `{accessToken, refreshToken}` que devuelve TokenService.issue(). Única
// definición para Swagger, compartida por POST /auth/login, /auth/refresh,
// /public/invitations/:token/accept y /me/password (antes había una copia con
// el mismo nombre en invitations, que Swagger fusionaba en silencio). Solo
// documenta la respuesta; no valida entrada.
export class AuthTokensDto {
  @ApiProperty()
  accessToken!: string;

  @ApiPropertyOptional({
    description:
      'Solo sin `X-Refresh-Transport: cookie` (clientes antiguos). En modo cookie el refresh viaja en la cookie HttpOnly `dentalix_rt` (Path=/api/v1/auth) y no se devuelve aquí. Nunca en un acceso break-glass.',
  })
  refreshToken?: string;

  @ApiPropertyOptional({
    description:
      'SEC-008: `true` en el acceso de soporte de un superadmin a una clínica sin membresía. El token no se puede renovar: al caducar hay que volver a entrar.',
  })
  breakGlass?: boolean;

  @ApiPropertyOptional({
    description: 'SEC-008: caducidad del token break-glass (ISO 8601).',
    format: 'date-time',
  })
  expiresAt?: string;
}
