import { ApiProperty } from '@nestjs/swagger';
import { IsRateDate, RATE_DATE_DESCRIPTION } from './rate-date.validator';

export class GetRatesQueryDto {
  @ApiProperty({
    example: '2026-07-01',
    format: 'date',
    description: RATE_DATE_DESCRIPTION,
  })
  @IsRateDate()
  date!: string;
}
