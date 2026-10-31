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
import { ANSWER_STATUSES } from '../../domain/anamnesis-answers';
import type { AnswerStatus } from '../../domain/entities/medical-history.entity';

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

  @ApiProperty({
    type: [ConditionDto],
    description:
      'Solo las condiciones que se contestaron (Sí / No / No sabe). Una condición del checklist que no figura está «Sin responder»: nunca se interpreta como «No».',
  })
  conditions!: ConditionDto[];

  @ApiProperty({ type: [MedicationDto] })
  medications!: MedicationDto[];

  @ApiProperty({ type: HabitsDto, nullable: true })
  habits!: HabitsDto | null;

  @ApiProperty({
    enum: ANSWER_STATUSES,
    enumName: 'AnamnesisAnswerStatus',
    nullable: true,
    description:
      'Embarazo: SI / NO / DESCONOCE; null = sin responder. En las versiones anteriores a este campo solo se guardaba el «Sí»: allí null puede ser «No» o no preguntado (nunca se inventa un «No»).',
  })
  pregnancy!: AnswerStatus | null;

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

  @ApiProperty({
    enum: ['STAFF', 'PATIENT_FORM'],
    enumName: 'MedicalHistorySource',
    description:
      'DX-099: STAFF = la tecleó el personal; PATIENT_FORM = la aceptó un profesional (el autor) desde el formulario que llenó el paciente por enlace.',
  })
  source!: 'STAFF' | 'PATIENT_FORM';

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}
