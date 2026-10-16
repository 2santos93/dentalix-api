import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

export class ListConsentTemplatesQueryDto {
  @ApiPropertyOptional({
    description: 'true = solo activas; false = solo inactivas; sin él, todas',
  })
  @IsOptional()
  // Igual que ListCatalogItemsQueryDto: `Boolean('false')` sería `true`.
  @Transform(({ value }: { value: unknown }) =>
    value === undefined ? undefined : value === true || value === 'true',
  )
  @IsBoolean()
  active?: boolean;
}
