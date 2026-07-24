import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsNumber, IsString, Matches, Min } from 'class-validator';

// Uppercase-normalizes ISO 4217 codes so `from=usd` behaves the same as
// `from=USD` — snapshots are stored uppercase (see PrismaExchangeRateRepository
// / OpenExchangeRatesProvider), so this keeps query input consistent with them.
function toUpperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.toUpperCase() : value;
}

export class ConvertQueryDto {
  @ApiProperty({ example: 100, minimum: 0 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount!: number;

  @ApiProperty({ example: 'USD', description: 'ISO 4217 currency code' })
  @Transform(toUpperCase)
  @IsString()
  from!: string;

  @ApiProperty({ example: 'COP', description: 'ISO 4217 currency code' })
  @Transform(toUpperCase)
  @IsString()
  to!: string;

  @ApiProperty({
    example: '2026-07-01',
    description: 'Historical day whose rate applies to this conversion (YYYY-MM-DD).',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must match YYYY-MM-DD' })
  date!: string;
}
