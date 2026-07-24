import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, Matches } from 'class-validator';

// Uppercase-normalizes ISO 4217 codes, same convention as ConvertQueryDto
// (exchange module) / CreateSaleDto.
function toUpperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.toUpperCase() : value;
}

// `from`/`to`/`currency` are all REQUIRED here -- unlike ListSalesQueryDto,
// GetSalesTotalsUseCase / SaleRepository.listForTotals need a concrete
// `[from, to)` window (ListSalesForTotalsParams has no optional fields), and
// a totals report with no target currency is meaningless. `currency` closes
// Task 2's note: `@Matches` both rejects blank/whitespace-only values AND
// enforces an ISO-4217-ish shape (2-8 uppercase letters, applied AFTER the
// uppercase transform) -- `GetSalesTotalsUseCase` itself does not validate
// this, so the DTO is the single place that guards against
// `?currency=` / `?currency=%20` reaching the use case.
export class SalesTotalsQueryDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'Inclusive lower bound on paidAt (half-open range [from, to)).',
  })
  @IsDateString()
  from!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'Exclusive upper bound on paidAt (half-open range [from, to)).',
  })
  @IsDateString()
  to!: string;

  @ApiProperty({
    example: 'USD',
    description: 'ISO 4217 currency code to convert every sale total into.',
  })
  @Transform(toUpperCase)
  @Matches(/^[A-Z]{2,8}$/, {
    message: 'currency must be a non-empty ISO 4217-like code',
  })
  currency!: string;
}
