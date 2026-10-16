import { ApiProperty } from '@nestjs/swagger';
import {
  CatalogKind,
  ToothRecordOrigin,
  ToothRecordStatus,
  ToothSurface,
} from '@prisma/client';

// Response shape for ToothRecord endpoints — documents the ToothRecord
// entity contract for Swagger (same convention as BrandingDto /
// StaffMemberDto). The use cases already return values shaped exactly like
// this (ToothRecord entity, see ../../domain/entities/tooth-record.entity.ts);
// this class exists purely for `@ApiProperty` documentation, not for input
// validation.
export class ToothRecordDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ description: 'FDI/ISO-3950 tooth code' })
  toothNumber!: string;

  @ApiProperty({ enum: ToothSurface, isArray: true })
  surfaces!: ToothSurface[];

  @ApiProperty({ enum: CatalogKind })
  kind!: CatalogKind;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  catalogItemId!: string | null;

  @ApiProperty({ enum: ToothRecordStatus })
  status!: ToothRecordStatus;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  clinicalEntryId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  performedById!: string | null;

  @ApiProperty({ enum: ToothRecordOrigin })
  origin!: ToothRecordOrigin;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'DX-120: si no es nulo, este registro es la ANULACIÓN del registro con ese id',
  })
  voidsRecordId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  voidReason!: string | null;

  @ApiProperty({ format: 'date-time' })
  recordedAt!: Date;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

/** DX-120: la anulación de un registro, vista desde el anulado. */
export class ToothRecordVoidDto {
  @ApiProperty({ format: 'uuid', description: 'Id del registro de anulación' })
  id!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  performedById!: string | null;

  @ApiProperty({ type: String, nullable: true })
  performedByName!: string | null;

  @ApiProperty({ format: 'date-time' })
  recordedAt!: Date;
}

/** DX-120: entrada del historial de un diente (incluye los anulados, marcados). */
export class ToothTimelineEntryDto extends ToothRecordDto {
  @ApiProperty({ type: String, nullable: true })
  performedByName!: string | null;

  @ApiProperty({
    type: ToothRecordVoidDto,
    nullable: true,
    description: 'Anulación del registro; null si sigue vigente',
  })
  void!: ToothRecordVoidDto | null;
}
