import { ApiProperty } from '@nestjs/swagger';
import {
  AllergyDto,
  ConditionDto,
  MedicationDto,
  HabitsDto,
  DentalHistoryDto,
  SurgeryDto,
  VitalSignsDto,
  SafetyFlagsDto,
} from './anamnesis-parts.dto';

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

  @ApiProperty({ type: [AllergyDto] })
  allergies!: AllergyDto[];

  @ApiProperty({ type: [ConditionDto] })
  conditions!: ConditionDto[];

  @ApiProperty({ type: [MedicationDto] })
  medications!: MedicationDto[];

  @ApiProperty({ type: HabitsDto, nullable: true })
  habits!: HabitsDto | null;

  @ApiProperty({ type: DentalHistoryDto, nullable: true })
  dentalHistory!: DentalHistoryDto | null;

  @ApiProperty({ type: [SurgeryDto] })
  surgeries!: SurgeryDto[];

  @ApiProperty({ type: VitalSignsDto, nullable: true })
  vitalSigns!: VitalSignsDto | null;

  @ApiProperty({ type: String, nullable: true })
  familyHistory!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ type: SafetyFlagsDto })
  safetyFlags!: SafetyFlagsDto;

  @ApiProperty()
  hasCriticalAlert!: boolean;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}
