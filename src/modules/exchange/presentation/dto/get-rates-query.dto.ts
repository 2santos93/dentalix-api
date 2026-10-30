import { ApiProperty } from '@nestjs/swagger';
import { IsRateDate, RATE_DATE_API_PROPERTY } from './rate-date.validator';

export class GetRatesQueryDto {
  @ApiProperty(RATE_DATE_API_PROPERTY)
  @IsRateDate()
  date!: string;
}
