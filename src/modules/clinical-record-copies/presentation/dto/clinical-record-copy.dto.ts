import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  AnesthesiaTechnique,
  AppointmentStatus,
  AsaClass,
  CatalogKind,
  ClinicalDiagnosisKind,
  ConsentSignerType,
  PrescriptionStatus,
  SedationAgentKind,
  SedationDoseUnit,
  SedationGrade,
  SedationRoute,
  ToothRecordOrigin,
  ToothRecordStatus,
  ToothSurface,
} from '@prisma/client';
import {
  AllergyDto,
  ConditionDto,
  DentalHistoryDto,
  HabitsDto,
  MedicationDto,
  SurgeryDto,
  VitalSignsDto,
} from '../../../medical-history/presentation/dto/anamnesis-parts.dto';
import { ANSWER_STATUSES } from '../../../medical-history/domain/anamnesis-answers';
import type { AnswerStatus } from '../../../medical-history/domain/entities/medical-history.entity';
import {
  CLINICAL_RECORD_COPY_SECTIONS,
  type ClinicalRecordCopySection,
} from '../../domain/clinical-record-copy';

const CIVIL_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SECTIONS = [...CLINICAL_RECORD_COPY_SECTIONS];

export class CreateClinicalRecordCopyDto {
  @ApiProperty({
    example: '2026-01-01',
    description: 'Primer día (inclusive), día civil de la sede.',
  })
  @IsString()
  @Matches(CIVIL_DAY)
  from!: string;

  @ApiProperty({
    example: '2026-03-31',
    description: 'Último día (inclusive), día civil de la sede.',
  })
  @IsString()
  @Matches(CIVIL_DAY)
  to!: string;

  @ApiProperty({
    enum: SECTIONS,
    enumName: 'ClinicalRecordCopySection',
    isArray: true,
    minItems: 1,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SECTIONS.length)
  @IsIn(SECTIONS, { each: true })
  sections!: ClinicalRecordCopySection[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 120,
    example: 'Ana Pérez (madre)',
    description:
      'A quién se entrega (opcional, una línea). Queda en la generación; nunca en la auditoría.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  deliveredTo?: string | null;
}

export class ClinicalRecordCopyAuthorDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
}

export class ClinicalRecordCopyLocationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class ClinicalRecordCopySummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: '2026-01-01' }) from!: string;
  @ApiProperty({ example: '2026-03-31' }) to!: string;
  @ApiProperty({
    enum: SECTIONS,
    enumName: 'ClinicalRecordCopySection',
    isArray: true,
  })
  sections!: ClinicalRecordCopySection[];
  @ApiProperty({ type: String, nullable: true }) deliveredTo!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) generatedAt!: Date;
  @ApiProperty({ type: ClinicalRecordCopyAuthorDto })
  generatedBy!: ClinicalRecordCopyAuthorDto;
  @ApiProperty({ type: ClinicalRecordCopyLocationDto })
  location!: ClinicalRecordCopyLocationDto;
}

// ---------------------------------------------------------------------------
// Documento
// ---------------------------------------------------------------------------

export class CopyClinicDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) legalName!: string | null;
  @ApiProperty({ type: String, nullable: true }) taxIdLabel!: string | null;
  @ApiProperty({ type: String, nullable: true }) taxId!: string | null;
}

export class CopyLocationDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
  @ApiProperty({ example: 'America/Caracas' }) timeZone!: string;
  @ApiProperty({ type: String, nullable: true, example: 'es-VE' })
  locale!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'h12' })
  hourCycle!: string | null;
}

export class CopyPatientDto {
  @ApiProperty() name!: string;
  @ApiProperty() patientCode!: number;
  @ApiProperty({ type: String, nullable: true }) document!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '1990-05-14' })
  birthDate!: string | null;
}

export class CopyDiagnosisDto {
  @ApiProperty() icd10Code!: string;
  @ApiProperty() label!: string;
  @ApiProperty({
    enum: ClinicalDiagnosisKind,
    enumName: 'ClinicalDiagnosisKind',
  })
  kind!: ClinicalDiagnosisKind;
  @ApiProperty({ type: String, nullable: true }) toothFdi!: string | null;
}

export class CopyAddendumDto {
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, nullable: true }) authorName!: string | null;
  @ApiProperty() reason!: string;
  @ApiProperty() text!: string;
}

export class CopyEvolutionDto {
  @ApiProperty({ type: String, format: 'date-time' }) entryDate!: Date;
  @ApiProperty({ type: String, nullable: true }) authorName!: string | null;
  @ApiProperty({ type: String, nullable: true }) authorLicense!: string | null;
  @ApiProperty({ type: String, nullable: true }) locationName!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  appointmentStart!: Date | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty() notes!: string;
  @ApiProperty({ type: [CopyDiagnosisDto] }) diagnoses!: CopyDiagnosisDto[];
  @ApiProperty({ type: [CopyAddendumDto] }) addenda!: CopyAddendumDto[];
}

export class CopyDiagnosisLineDto extends CopyDiagnosisDto {
  @ApiProperty({ type: String, format: 'date-time' }) entryDate!: Date;
  @ApiProperty({ type: String, nullable: true }) authorName!: string | null;
}

export class CopyAnamnesisDto {
  @ApiProperty() version!: number;
  @ApiProperty({ type: String, format: 'date-time' }) recordedAt!: Date;
  @ApiProperty({ type: String, nullable: true }) authorName!: string | null;
  @ApiProperty({ enum: ['STAFF', 'PATIENT_FORM'] }) source!: string;
  @ApiProperty({ type: [AllergyDto] }) allergies!: AllergyDto[];
  @ApiProperty({ type: [ConditionDto] }) conditions!: ConditionDto[];
  @ApiProperty({ type: [MedicationDto] }) medications!: MedicationDto[];
  @ApiProperty({ type: [SurgeryDto] }) surgeries!: SurgeryDto[];
  @ApiProperty({ type: HabitsDto, nullable: true }) habits!: HabitsDto | null;
  @ApiProperty({
    enum: ANSWER_STATUSES,
    enumName: 'AnamnesisAnswerStatus',
    nullable: true,
  })
  pregnancy!: AnswerStatus | null;
  @ApiProperty({ type: DentalHistoryDto, nullable: true })
  dentalHistory!: DentalHistoryDto | null;
  @ApiProperty({ type: VitalSignsDto, nullable: true })
  vitalSigns!: VitalSignsDto | null;
  @ApiProperty({ type: String, nullable: true }) familyHistory!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
}

export class CopyToothRecordDto {
  @ApiProperty() toothNumber!: string;
  @ApiProperty({ type: String, format: 'date-time' }) recordedAt!: Date;
  @ApiProperty({ enum: CatalogKind, enumName: 'CatalogKind' })
  kind!: CatalogKind;
  @ApiProperty({ type: String, nullable: true }) label!: string | null;
  @ApiProperty({ enum: ToothSurface, enumName: 'ToothSurface', isArray: true })
  surfaces!: ToothSurface[];
  @ApiProperty({ enum: ToothRecordStatus, enumName: 'ToothRecordStatus' })
  status!: ToothRecordStatus;
  @ApiProperty({ enum: ToothRecordOrigin, enumName: 'ToothRecordOrigin' })
  origin!: ToothRecordOrigin;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: String, nullable: true }) authorName!: string | null;
}

export class CopyAnesthesiaDto {
  @ApiProperty({ type: String, format: 'date-time' }) administeredAt!: Date;
  @ApiProperty() anestheticName!: string;
  @ApiProperty() activeIngredient!: string;
  @ApiProperty() concentrationPct!: number;
  @ApiProperty({ type: String, nullable: true }) vasoconstrictor!:
    string | null;
  @ApiProperty() carpules!: number;
  @ApiProperty() doseMg!: number;
  @ApiProperty({ enum: AnesthesiaTechnique, enumName: 'AnesthesiaTechnique' })
  technique!: AnesthesiaTechnique;
  @ApiProperty({ type: String, nullable: true }) site!: string | null;
  @ApiProperty({ type: String, nullable: true }) lot!: string | null;
  @ApiProperty({ type: String, nullable: true }) authorName!: string | null;
  @ApiProperty({ type: String, nullable: true }) locationName!: string | null;
}

export class CopySedationAgentDto {
  @ApiProperty({ type: String, format: 'date-time' }) administeredAt!: Date;
  @ApiProperty({ enum: SedationAgentKind, enumName: 'SedationAgentKind' })
  kind!: SedationAgentKind;
  @ApiProperty({ type: String, nullable: true }) drugName!: string | null;
  @ApiProperty({ type: Number, nullable: true }) dose!: number | null;
  @ApiProperty({
    enum: SedationDoseUnit,
    enumName: 'SedationDoseUnit',
    nullable: true,
  })
  doseUnit!: SedationDoseUnit | null;
  @ApiProperty({ enum: SedationRoute, enumName: 'SedationRoute' })
  route!: SedationRoute;
  @ApiProperty({ type: Number, nullable: true }) n2oPercent!: number | null;
}

export class CopySedationDto {
  @ApiProperty({ type: String, format: 'date-time' }) assessedAt!: Date;
  @ApiProperty({ enum: SedationGrade, enumName: 'SedationGrade' })
  grade!: SedationGrade;
  @ApiProperty({ enum: AsaClass, enumName: 'AsaClass', nullable: true })
  asaClass!: AsaClass | null;
  @ApiProperty({ type: String, nullable: true }) authorName!: string | null;
  @ApiProperty({ type: String, nullable: true }) locationName!: string | null;
  @ApiProperty({ type: [CopySedationAgentDto] })
  agents!: CopySedationAgentDto[];
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  dischargedAt!: Date | null;
}

export class CopyConsentDto {
  @ApiProperty() title!: string;
  @ApiProperty({ type: String, format: 'date-time' }) signedAt!: Date;
  @ApiProperty({ enum: ConsentSignerType, enumName: 'ConsentSignerType' })
  signerType!: ConsentSignerType;
  @ApiProperty() signerName!: string;
  @ApiProperty() professionalName!: string;
  @ApiProperty() complete!: boolean;
}

export class CopyPrescriptionItemDto {
  @ApiProperty() activeIngredient!: string;
  @ApiProperty({ type: String, nullable: true }) brandName!: string | null;
  @ApiProperty() concentration!: string;
  @ApiProperty() pharmaceuticalForm!: string;
  @ApiProperty() route!: string;
  @ApiProperty() dose!: string;
  @ApiProperty() frequency!: string;
  @ApiProperty() durationDays!: number;
  @ApiProperty({ type: String, nullable: true }) instructions!: string | null;
}

export class CopyPrescriptionDto {
  @ApiProperty({ type: String, format: 'date-time' }) issuedAt!: Date;
  @ApiProperty() professionalName!: string;
  @ApiProperty() locationName!: string;
  @ApiProperty({ enum: PrescriptionStatus, enumName: 'PrescriptionStatus' })
  status!: PrescriptionStatus;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: [CopyPrescriptionItemDto] })
  items!: CopyPrescriptionItemDto[];
}

export class CopyAppointmentDto {
  @ApiProperty({ type: String, format: 'date-time' }) start!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) end!: Date;
  @ApiProperty({ enum: AppointmentStatus, enumName: 'AppointmentStatus' })
  status!: AppointmentStatus;
  @ApiProperty({ type: String, nullable: true }) providerName!: string | null;
  @ApiProperty({ type: String, nullable: true }) locationName!: string | null;
  @ApiProperty({ type: String, nullable: true }) typeName!: string | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
}

/** Solo trae las claves de las secciones elegidas. */
export class CopyContentDto {
  @ApiPropertyOptional({ type: [CopyEvolutionDto] })
  evolutions?: CopyEvolutionDto[];
  @ApiPropertyOptional({ type: [CopyDiagnosisLineDto] })
  diagnoses?: CopyDiagnosisLineDto[];
  @ApiPropertyOptional({ type: [CopyAnamnesisDto] })
  anamnesis?: CopyAnamnesisDto[];
  @ApiPropertyOptional({ type: [CopyToothRecordDto] })
  odontogram?: CopyToothRecordDto[];
  @ApiPropertyOptional({ type: [CopyAnesthesiaDto] })
  anesthesia?: CopyAnesthesiaDto[];
  @ApiPropertyOptional({ type: [CopySedationDto] })
  sedation?: CopySedationDto[];
  @ApiPropertyOptional({ type: [CopyConsentDto] })
  consents?: CopyConsentDto[];
  @ApiPropertyOptional({ type: [CopyPrescriptionDto] })
  prescriptions?: CopyPrescriptionDto[];
  @ApiPropertyOptional({ type: [CopyAppointmentDto] })
  appointments?: CopyAppointmentDto[];
}

export class ClinicalRecordCopyDocumentDto {
  @ApiProperty({ type: ClinicalRecordCopySummaryDto })
  copy!: ClinicalRecordCopySummaryDto;
  @ApiProperty({ type: CopyClinicDto }) clinic!: CopyClinicDto;
  @ApiProperty({ type: CopyLocationDto }) location!: CopyLocationDto;
  @ApiProperty({ type: CopyPatientDto }) patient!: CopyPatientDto;
  @ApiProperty({ type: CopyContentDto }) content!: CopyContentDto;
  @ApiProperty({
    description: 'Ninguna sección elegida trae registros en el período.',
  })
  empty!: boolean;
}
