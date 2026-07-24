import { ApiProperty } from '@nestjs/swagger';

// Response shape for POST /auth/register — documents the
// `{tenantId, userId}` contract for Swagger (see
// ../../application/use-cases/register-clinic.use-case.ts). Registration
// creates the clinic + owner user but does NOT log the caller in — it
// returns identifiers, not tokens; a subsequent POST /auth/login (see
// AuthTokensDto) issues the session. This class exists purely for
// `@ApiProperty` documentation, not for input validation.
export class RegisterResponseDto {
  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;
}
