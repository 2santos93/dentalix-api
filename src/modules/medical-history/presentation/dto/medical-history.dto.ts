import { ApiProperty } from '@nestjs/swagger';

// Response shape for MedicalHistory endpoints — documents the
// MedicalHistoryVersion entity contract for Swagger (same convention as
// BrandingDto / StaffMemberDto). The use cases already return values shaped
// exactly like this (MedicalHistory entity, see
// ../../domain/entities/medical-history.entity.ts); this class exists
// purely for `@ApiProperty` documentation, not for input validation.
export class MedicalHistoryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty()
  version!: number;

  @ApiProperty({ type: String, nullable: true })
  allergies!: string | null;

  @ApiProperty({ type: String, nullable: true })
  chronicConditions!: string | null;

  @ApiProperty({ type: String, nullable: true })
  currentMedications!: string | null;

  @ApiProperty({ type: String, nullable: true })
  habits!: string | null;

  @ApiProperty({ type: String, nullable: true })
  medicalAlerts!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}
