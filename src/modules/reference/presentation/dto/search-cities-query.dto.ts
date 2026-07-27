import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class SearchCitiesQueryDto {
  @ApiProperty({ example: 'CO', description: 'ISO 3166-1 alpha-2 country code' })
  @IsString()
  @Length(2, 2)
  countryCode!: string;

  @ApiPropertyOptional({ description: 'Case-insensitive name filter' })
  @IsOptional()
  @IsString()
  q?: string;

  // No @Max here: values above 50 are accepted by validation and silently
  // clamped to 50 by SearchCitiesUseCase, per the endpoint contract
  // ("clamped to max 50", not rejected) — an upper-bound validator here
  // would 400 exactly the requests the use-case is meant to cap.
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
