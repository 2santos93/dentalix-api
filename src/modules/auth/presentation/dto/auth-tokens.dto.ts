import { ApiProperty } from '@nestjs/swagger';

// Par `{accessToken, refreshToken}` que devuelve TokenService.issue(). Única
// definición para Swagger, compartida por POST /auth/login, /auth/refresh,
// /public/invitations/:token/accept y /me/password (antes había una copia con
// el mismo nombre en invitations, que Swagger fusionaba en silencio). Solo
// documenta la respuesta; no valida entrada.
export class AuthTokensDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;
}
