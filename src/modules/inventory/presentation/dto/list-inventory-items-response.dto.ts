import { ApiProperty } from '@nestjs/swagger';
import { InventoryItemDto } from './inventory-item.dto';

// Response shape for GET /inventory/items -- documents the
// `{items, total, page, pageSize}` contract for Swagger (mirrors
// ListInventoryItemsOutput, see
// ../../application/use-cases/list-inventory-items.use-case.ts). Same
// convention as ListPatientsResponseDto: exists purely for `@ApiProperty`
// documentation, not input validation.
export class ListInventoryItemsResponseDto {
  @ApiProperty({ type: [InventoryItemDto] })
  items!: InventoryItemDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
