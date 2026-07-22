import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { CatalogKind } from '@prisma/client';

export class ListCatalogItemsQueryDto {
  @ApiPropertyOptional({ enum: CatalogKind })
  @IsOptional()
  @IsEnum(CatalogKind)
  kind?: CatalogKind;

  @ApiPropertyOptional({
    description: 'When true, only returns active items',
  })
  @IsOptional()
  // Plain `@Type(() => Boolean)` is a footgun for query strings: `Boolean('false')`
  // is `true`. Map explicitly instead, and leave an absent param as `undefined`
  // (not `false`) so "no filter" and "filter=false" stay distinguishable.
  @Transform(({ value }: { value: unknown }) =>
    value === undefined ? undefined : value === true || value === 'true',
  )
  @IsBoolean()
  activeOnly?: boolean;
}
