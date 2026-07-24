import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InventoryMovementDto } from './inventory-movement.dto';

// Response shape for InventoryItem endpoints -- documents the
// InventoryItem/InventoryItemWithStock/InventoryItemDetail entity contracts
// for Swagger in a single class (same convention as TreatmentPlanDto /
// SaleDto: this exists purely for `@ApiProperty` documentation, not input
// validation). Deliberately NO `tenantId` field -- same call as
// SaleDto/SaleLineItemDto (tenant is an internal RLS concern, never echoed
// back to the client). `stock`/`lowStock` are only populated by
// GET /inventory/items (list) and GET /inventory/items/:id (detail) -- see
// ListInventoryItemsUseCase/GetInventoryItemUseCase; POST/PATCH return the
// bare item, so both fields are optional here. `movements` is only
// populated by GET /inventory/items/:id.
export class InventoryItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Guantes de nitrilo' })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  sku!: string | null;

  @ApiProperty({ example: 'caja' })
  unit!: string;

  @ApiProperty({ example: 5 })
  minStock!: number;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  @ApiPropertyOptional({
    description:
      'Σ signed movements (IN +, OUT -, ADJUSTMENT ±). Computed, never stored.',
  })
  stock?: number;

  @ApiPropertyOptional({ description: 'true when stock <= minStock' })
  lowStock?: boolean;

  @ApiPropertyOptional({ type: [InventoryMovementDto] })
  movements?: InventoryMovementDto[];
}
