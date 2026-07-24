import { ApiProperty } from '@nestjs/swagger';

// Response shape for GET /sales/totals -- documents GetSalesTotalsResult for
// Swagger (same convention as ConvertResponseDto/RatesResponseDto: exists
// purely for `@ApiProperty` docs, not input validation).
export class SalesTotalsDto {
  @ApiProperty({ type: String, format: 'date-time' })
  from!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  to!: Date;

  @ApiProperty({ example: 'USD', description: 'ISO 4217 currency code' })
  currency!: string;

  @ApiProperty({
    example: 1250.5,
    description:
      "Sum of every active sale's total in the range, each converted to " +
      "`currency` using ITS OWN paidAt date (never today's rate).",
  })
  totalConverted!: number;

  @ApiProperty({
    example: 12,
    description: 'Number of active sales in the range, any currency.',
  })
  count!: number;

  @ApiProperty({
    example: { COP: 500000, USD: 30 },
    description:
      "Breakdown of the ORIGINAL (unconverted) totals grouped by each sale's own currency.",
  })
  byCurrency!: Record<string, number>;
}
