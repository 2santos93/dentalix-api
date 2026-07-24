import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { InventoryMovementType } from '@prisma/client';

// NOTE: deliberately NO `itemId`/`tenantId`/`createdById`/`occurredAt`
// field -- `itemId` comes from the route param (never duplicated in the
// body), tenant from the guarded request context, `createdById` from the
// authenticated user (req.user.sub), `occurredAt` defaults to `now()` at
// the schema level (v1 has no "backdated movement" use case) -- same
// convention as CreateSaleLineItemDto omitting derived/contextual fields.
//
// `quantity` uses `@IsNumber()` (NOT `@IsInt()`) -- the schema allows
// `Decimal(14,3)` fractional quantities (e.g. "12.5 ml") -- and
// `@IsNumber()` rejects `NaN`/`Infinity` by default (`allowNaN`/
// `allowInfinity` both default to `false`), which is what closes Task 2's
// finiteness note (`RecordInventoryMovementUseCase` no longer needs to
// separately reject a non-finite `quantity` reaching it from this DTO).
// Deliberately NO `@IsPositive()`/`@Min()` here -- IN/OUT must be `> 0` but
// ADJUSTMENT may be negative or positive (never `0`); that
// type-dependent sign/zero rule is enforced by
// `RecordInventoryMovementUseCase`, not this DTO.
export class RecordInventoryMovementDto {
  @ApiProperty({ enum: InventoryMovementType })
  @IsEnum(InventoryMovementType)
  type!: InventoryMovementType;

  @ApiProperty({
    example: 10,
    description:
      'Always > 0 for IN/OUT; may be negative (and never 0) for ADJUSTMENT.',
  })
  @IsNumber()
  quantity!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}
