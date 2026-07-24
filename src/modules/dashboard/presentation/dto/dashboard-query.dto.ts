import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Min } from 'class-validator';

// Uppercase-normalizes ISO 4217 codes before validation -- same convention
// as CreatePaymentDto (payments, PAY-T3).
function toUpperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.toUpperCase() : value;
}

// `from`/`to` are plain calendar dates (YYYY-MM-DD, no time component) --
// the dashboard is queried by day-granularity period. The controller turns
// each into a UTC-midnight `Date` via `new Date(...)` before calling
// GetDoctorDashboardUseCase (a date-only ISO string always parses as UTC
// midnight, matching the convention documented on
// GetPaymentsTotalsUseCase.toUtcDateString: exchange snapshots are always
// keyed/compared in UTC).
export class DashboardQueryDto {
  @ApiProperty({
    example: '2026-07-01',
    description: 'Inclusive period start (YYYY-MM-DD).',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must match YYYY-MM-DD' })
  from!: string;

  @ApiProperty({
    example: '2026-07-31',
    description:
      'Period end (YYYY-MM-DD). Passed through to GetPaymentsTotalsUseCase, ' +
      'which treats the incomes/payments range as half-open [from, to).',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must match YYYY-MM-DD' })
  to!: string;

  @ApiProperty({
    example: 'USD',
    description:
      'ISO 4217 currency code every payment amount is converted into.',
  })
  @Transform(toUpperCase)
  @Matches(/^[A-Z]{2,8}$/, {
    message: 'currency must be a non-empty ISO 4217-like code',
  })
  currency!: string;

  @ApiPropertyOptional({
    minimum: 1,
    default: 5,
    description: 'Max number of upcoming appointments to return.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  upcomingLimit?: number;
}
