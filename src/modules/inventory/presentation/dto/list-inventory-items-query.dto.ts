import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

// Mirrors ListPatientsQueryDto (list-patients-query.dto.ts) plus
// `lowStockOnly`. Query params always arrive as strings, so `lowStockOnly`
// needs an explicit `@Transform` -- without it, the string `"false"` is
// truthy and the filter would stay permanently on.
export class ListInventoryItemsQueryDto {
  @ApiPropertyOptional({ description: 'Búsqueda libre (nombre o SKU)' })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  @ApiPropertyOptional({
    description: 'Solo insumos en o por debajo del mínimo',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  lowStockOnly?: boolean;
}
