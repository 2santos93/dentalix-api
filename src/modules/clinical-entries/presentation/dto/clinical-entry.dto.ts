import { ApiProperty } from '@nestjs/swagger';

// Response shape for ClinicalEntry endpoints — documents the ClinicalEntry
// entity contract for Swagger (same convention as BrandingDto /
// StaffMemberDto). The use cases already return values shaped exactly like
// this (ClinicalEntry entity, see
// ../../domain/entities/clinical-entry.entity.ts); this class exists purely
// for `@ApiProperty` documentation, not for input validation.
export class ClinicalEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ format: 'date-time' })
  entryDate!: Date;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty()
  notes!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  performedById!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}
