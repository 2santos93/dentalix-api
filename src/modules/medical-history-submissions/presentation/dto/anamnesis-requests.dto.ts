import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MedicalHistorySubmissionStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SafetyFlagsDto } from '../../../medical-history/presentation/dto/anamnesis-parts.dto';
import { SaveMedicalHistoryDto } from '../../../medical-history/presentation/dto/save-medical-history.dto';
import { AnamnesisAnswersDto } from './anamnesis-answers.dto';

const STATUS_PROPERTY = {
  enum: MedicalHistorySubmissionStatus,
  enumName: 'MedicalHistorySubmissionStatus',
  description:
    'PENDING_PATIENT = esperando al paciente; SUBMITTED = por revisar; ACCEPTED / REJECTED = revisada; EXPIRED = caducada o anulada.',
};

export class CreateAnamnesisRequestDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Cita del paciente: el enlace caduca a su inicio (o a los 7 días, lo que llegue antes) y la anamnesis va a la bandeja de su sede.',
  })
  @IsOptional()
  @IsUUID()
  appointmentId?: string;
}

export class AnamnesisWhatsAppDto {
  @ApiProperty({ description: 'E.164 sin «+», para wa.me' }) phone!: string;
  @ApiProperty({
    description: 'Mensaje prellenado: saludo, clínica y enlace; nada clínico',
  })
  text!: string;
}

export class AnamnesisRequestCreatedDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  appointmentId!: string | null;
  @ApiProperty({
    description:
      'Enlace público. El token solo viaja en esta respuesta: la API guarda su hash.',
  })
  url!: string;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: Date;
  @ApiProperty({ type: AnamnesisWhatsAppDto, nullable: true })
  whatsapp!: AnamnesisWhatsAppDto | null;
  @ApiProperty({ type: String, nullable: true })
  whatsappUnavailableReason!: string | null;
  @ApiProperty({
    description:
      'El paciente no tiene vigente SENSITIVE_HEALTH: el formulario la pedirá antes.',
  })
  consentRequired!: boolean;
}

class SubmissionPatientDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
}
class SubmissionAppointmentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'date-time' }) start!: Date;
}
class SubmissionLocationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

/** Un envío en la ficha o en la bandeja: sin respuestas. */
export class AnamnesisSubmissionSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: SubmissionPatientDto }) patient!: SubmissionPatientDto;
  @ApiProperty({ type: SubmissionAppointmentDto, nullable: true })
  appointment!: SubmissionAppointmentDto | null;
  @ApiProperty({ type: SubmissionLocationDto })
  location!: SubmissionLocationDto;
  @ApiProperty(STATUS_PROPERTY) status!: MedicalHistorySubmissionStatus;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty() createdByName!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  submittedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reviewedAt!: Date | null;
  @ApiProperty({ type: String, nullable: true })
  reviewedByName!: string | null;
  @ApiProperty({ type: String, nullable: true })
  rejectReason!: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Versión de la HC que creó al aceptarse',
  })
  resultingVersionId!: string | null;
}

export class AnamnesisInboxQueryDto {
  @ApiPropertyOptional({ ...STATUS_PROPERTY, default: 'SUBMITTED' })
  @IsOptional()
  @IsEnum(MedicalHistorySubmissionStatus)
  status?: MedicalHistorySubmissionStatus;
}

export class AnamnesisInboxSummaryDto {
  @ApiProperty({
    description: 'Anamnesis por revisar en las sedes del alcance de la sesión',
  })
  submitted!: number;
}

class CurrentVersionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
}

export class HistoryDiffEntryDto {
  @ApiProperty({
    enum: [
      'ALLERGIES',
      'CONDITIONS',
      'MEDICATIONS',
      'HABITS',
      'PREGNANCY',
      'SURGERIES',
    ],
    enumName: 'HistoryDiffSection',
  })
  section!: string;
  @ApiProperty() label!: string;
  @ApiProperty({
    enum: ['ADDED', 'REMOVED', 'CHANGED'],
    enumName: 'HistoryDiffChange',
  })
  change!: string;
  @ApiProperty({ type: String, nullable: true }) before!: string | null;
  @ApiProperty({ type: String, nullable: true }) after!: string | null;
  @ApiProperty({ description: 'Hay un «Sí» a un lado u otro (va primero)' })
  affirmative!: boolean;
}

export class HistoryDiffDto {
  @ApiProperty() hasPreviousVersion!: boolean;
  @ApiProperty({ type: [HistoryDiffEntryDto] })
  entries!: HistoryDiffEntryDto[];
  @ApiProperty() unchangedCount!: number;
}

class ProposedFlagsDto {
  @ApiProperty({ type: SafetyFlagsDto }) safetyFlags!: SafetyFlagsDto;
  @ApiProperty() hasCriticalAlert!: boolean;
}

/** Vista de revisión: respuestas, vigente y diferencias. */
export class AnamnesisReviewDto {
  @ApiProperty({ type: AnamnesisSubmissionSummaryDto })
  submission!: AnamnesisSubmissionSummaryDto;
  @ApiProperty() questionnaireVersion!: string;
  @ApiProperty({ type: AnamnesisAnswersDto, nullable: true })
  answers!: AnamnesisAnswersDto | null;
  @ApiProperty() affirmativeCount!: number;
  @ApiProperty({ type: CurrentVersionDto, nullable: true })
  currentVersion!: CurrentVersionDto | null;
  @ApiProperty({
    type: SaveMedicalHistoryDto,
    nullable: true,
    description:
      'Lo que quedaría al aceptar sin ajustes (solo por revisar). Es lo que precarga «Ajustar».',
  })
  proposed!: SaveMedicalHistoryDto | null;
  @ApiProperty({ type: ProposedFlagsDto, nullable: true })
  proposedFlags!: ProposedFlagsDto | null;
  @ApiProperty({ type: HistoryDiffDto, nullable: true })
  diff!: HistoryDiffDto | null;
}

export class AcceptAnamnesisDto {
  @ApiPropertyOptional({
    type: SaveMedicalHistoryDto,
    description:
      'Ajustes del profesional: la versión completa a guardar. Sin él, se guarda la propuesta del envío.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SaveMedicalHistoryDto)
  medicalHistory?: SaveMedicalHistoryDto;
}

export class RejectAnamnesisDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3, { message: 'Escribe el motivo (al menos 3 caracteres).' })
  @MaxLength(500, { message: 'El motivo admite como mucho 500 caracteres.' })
  reason!: string;
}
