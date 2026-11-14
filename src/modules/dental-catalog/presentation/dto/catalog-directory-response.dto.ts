import { ApiProperty } from '@nestjs/swagger';
import { DentalCatalogItemDto } from './dental-catalog-item.dto';

/**
 * Forma de la respuesta de `GET /catalog/items/directory`. Existe solo para
 * documentar el contrato `{items, total, page, pageSize}` en Swagger —de ahí
 * sale el tipo del cliente web vía `openapi-typescript`—, no para validar
 * entrada. Misma convención que `ListInventoryItemsResponseDto` y
 * `ListPatientsResponseDto`.
 */
export class CatalogDirectoryResponseDto {
  @ApiProperty({ type: [DentalCatalogItemDto] })
  items!: DentalCatalogItemDto[];

  @ApiProperty({
    description: 'Total que casa con los filtros, no del catálogo entero',
  })
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-502-ter: moneda del `defaultPrice` de los ítems (la que fijó la clínica en Ajustes o, sin ella, la común de sus sedes activas); null si no se sabe. La ven todos los roles que leen el catálogo.',
  })
  catalogCurrency!: string | null;
}
