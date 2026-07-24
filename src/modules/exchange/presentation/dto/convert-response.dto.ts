import { ApiProperty } from '@nestjs/swagger';

// Response shape for GET /exchange/convert — documents the ConvertAmountResult
// contract for Swagger (see convert-amount.use-case.ts); the use case already
// returns values shaped exactly like this.
export class ConvertResponseDto {
  @ApiProperty({ example: 100 })
  amount!: number;

  @ApiProperty({ example: 'USD' })
  from!: string;

  @ApiProperty({ example: 'COP' })
  to!: string;

  @ApiProperty({ example: '2026-07-01' })
  date!: string;

  @ApiProperty({ example: 400000 })
  result!: number;

  @ApiProperty({
    example: 4000,
    description: 'Effective from→to rate actually applied.',
  })
  rateUsed!: number;
}
