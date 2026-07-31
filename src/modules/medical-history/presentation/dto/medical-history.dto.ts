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

  @ApiProperty({ type: [Object] })
  allergies!: unknown[];

  @ApiProperty({ type: [Object] })
  conditions!: unknown[];

  @ApiProperty({ type: [Object] })
  medications!: unknown[];

  @ApiProperty({ type: Object, nullable: true })
  habits!: Record<string, unknown> | null;

  @ApiProperty({ type: Object, nullable: true })
  dentalHistory!: Record<string, unknown> | null;

  @ApiProperty({ type: [Object] })
  surgeries!: unknown[];

  @ApiProperty({ type: Object, nullable: true })
  vitalSigns!: Record<string, unknown> | null;

  @ApiProperty({ type: String, nullable: true })
  familyHistory!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ type: Object })
  safetyFlags!: Record<string, unknown>;

  @ApiProperty()
  hasCriticalAlert!: boolean;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}
