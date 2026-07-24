import { ApiProperty } from '@nestjs/swagger';
import { InventoryMovementType } from '@prisma/client';

// Response shape for InventoryMovement, embedded in InventoryItemDto and
// returned bare by POST/GET .../movements -- documents the
// InventoryMovement entity contract for Swagger (same convention as
// SaleLineItemDto: exists purely for `@ApiProperty` docs, not input
// validation). Deliberately NO `tenantId` -- same call as SaleLineItemDto.
// No `deletedAt` either -- movements are immutable history, never
// soft-deleted (see InventoryMovement entity doc comment).
export class InventoryMovementDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  itemId!: string;

  @ApiProperty({ enum: InventoryMovementType })
  type!: InventoryMovementType;

  @ApiProperty({ example: 10 })
  quantity!: number;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty({ format: 'date-time' })
  occurredAt!: Date;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}
