import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { CatalogKind } from '@prisma/client';

/**
 * Query de `GET /catalog/items/directory` — la pantalla de gestión.
 *
 * Es `ListCatalogItemsQueryDto` (kind + activeOnly) más búsqueda y paginación.
 * No se amplió aquel en su sitio a propósito: lo consumen los selectores del
 * odontograma y del plan de tratamiento, que necesitan el catálogo completo, y
 * añadirles una página los rompería en silencio (verían solo los 20 primeros
 * procedimientos y nadie se enteraría hasta que faltara uno).
 */
export class ListCatalogDirectoryQueryDto {
  @ApiPropertyOptional({
    description: 'Búsqueda libre (código, etiqueta es/en/pt o categoría)',
  })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiPropertyOptional({ enum: CatalogKind })
  @IsOptional()
  @IsEnum(CatalogKind)
  kind?: CatalogKind;

  @ApiPropertyOptional({ description: 'Solo elementos activos' })
  @IsOptional()
  // `Boolean('false')` es `true`, así que el mapeo va explícito; un parámetro
  // ausente queda en `undefined` (no en `false`) para que "sin filtro" y
  // "filtro=false" sigan siendo distinguibles. Igual que en
  // ListCatalogItemsQueryDto.
  @Transform(({ value }: { value: unknown }) =>
    value === undefined ? undefined : value === true || value === 'true',
  )
  @IsBoolean()
  activeOnly?: boolean;

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
}
