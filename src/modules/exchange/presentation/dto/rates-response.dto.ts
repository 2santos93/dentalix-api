import { ApiProperty } from '@nestjs/swagger';

// Response shape for GET /exchange/rates — documents the RatesForDate
// contract for Swagger (same convention as StaffMemberDto/PatientDto: the
// use case already returns values shaped exactly like this; this class
// exists purely for `@ApiProperty` documentation, not input validation).
export class RatesResponseDto {
  @ApiProperty({ enum: ['USD'] })
  base!: 'USD';

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { COP: 4000, EUR: 0.92 },
    description: 'Units of each currency per 1 USD, for the requested date.',
  })
  rates!: Record<string, number>;
}
