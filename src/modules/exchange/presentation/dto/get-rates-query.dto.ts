import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class GetRatesQueryDto {
  @ApiProperty({
    example: '2026-07-01',
    description: 'Historical day to fetch USD-base rates for (YYYY-MM-DD).',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must match YYYY-MM-DD' })
  date!: string;
}
