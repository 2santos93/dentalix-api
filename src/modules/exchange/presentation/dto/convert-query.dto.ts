import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsNumber, IsString, Min } from 'class-validator';
import { IsRateDate, RATE_DATE_DESCRIPTION } from './rate-date.validator';

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

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  @Transform(toUpperCase)
  @IsString()
  from!: string;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  @Transform(toUpperCase)
  @IsString()
  to!: string;

  @ApiProperty({
    example: '2026-07-01',
    format: 'date',
    description: RATE_DATE_DESCRIPTION,
  })
  @IsRateDate()
  date!: string;
}
