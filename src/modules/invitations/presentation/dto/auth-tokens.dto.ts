import { ApiProperty } from '@nestjs/swagger';

// Response shape for POST /public/invitations/:token/accept — same pair
// TokenService.issue() returns for the regular login flow.
export class AuthTokensDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;
}
