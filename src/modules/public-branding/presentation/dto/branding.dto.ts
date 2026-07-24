import { ApiProperty } from '@nestjs/swagger';

// Response shape for GET /public/tenant/branding — documents the
// `{name, primaryColor, logoUrl}` contract for Swagger. The use case already
// returns values shaped exactly like this (TenantBranding entity); this class
// exists purely for `@ApiProperty` documentation (same convention as
// StaffMemberDto), not for input validation.
export class BrandingDto {
  @ApiProperty()
  name!: string;

  @ApiProperty()
  primaryColor!: string;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;
}
