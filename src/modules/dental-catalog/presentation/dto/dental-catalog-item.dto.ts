import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

  @ApiProperty({
    description:
      'DX-105: false = la prestación no admite descuentos (ni % de convenio ni discrecionales).',
  })
  allowDiscount!: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'DX-502-ter: moneda del `defaultPrice`, la del catálogo de la clínica; null si no se sabe. Solo la traen las lecturas (`GET /catalog/items`); es la misma en todos los ítems.',
  })
  catalogCurrency?: string | null;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'DX-455: plantilla de evolución ligada al procedimiento (el vínculo guardado, aunque la plantilla esté desactivada); null = ninguna. Es lo que edita la pantalla del catálogo.',
  })
  clinicalNoteTemplateId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'DX-455: plantilla a sugerir al marcar hecho el procedimiento: `clinicalNoteTemplateId` si la plantilla está activa; null si no hay o está desactivada.',
  })
  suggestedClinicalNoteTemplateId!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}
