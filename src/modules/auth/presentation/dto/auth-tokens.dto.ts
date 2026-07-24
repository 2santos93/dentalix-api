import { ApiProperty } from '@nestjs/swagger';

// Response shape for POST /auth/login — documents the
// `{accessToken, refreshToken}` contract for Swagger (see
// ../../application/use-cases/login.use-case.ts). This class exists purely
// for `@ApiProperty` documentation, not for input validation.
export class AuthTokensDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;
}
