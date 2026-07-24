import { ApiProperty } from '@nestjs/swagger';
import { CatalogKind } from '@prisma/client';

// Response shape for DentalCatalogItem endpoints — documents the
// DentalCatalogItem entity contract for Swagger (same convention as
// BrandingDto / StaffMemberDto). The use cases already return values shaped
// exactly like this (DentalCatalogItem entity, see
// ../../domain/entities/dental-catalog-item.entity.ts); this class exists
// purely for `@ApiProperty` documentation, not for input validation.
export class DentalCatalogItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ type: String, nullable: true })
  category!: string | null;

  @ApiProperty({ enum: CatalogKind })
  kind!: CatalogKind;

  @ApiProperty()
  labelEs!: string;

  @ApiProperty({ type: String, nullable: true })
  labelEn!: string | null;

  @ApiProperty({ type: String, nullable: true })
  labelPt!: string | null;

  @ApiProperty()
  color!: string;

  @ApiProperty({ type: Number, nullable: true })
  defaultPrice!: number | null;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}
