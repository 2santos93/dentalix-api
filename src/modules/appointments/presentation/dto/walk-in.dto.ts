import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { DocumentType, TriageFlag } from '@prisma/client';
import { DOCUMENT_TYPES } from '../../../patients/domain/document-type';
import { DOC_TYPE_LABEL_PROPERTY } from '../../../patients/presentation/dto/doc-type-input';
import { TRIAGE_FLAGS, TRIAGE_NOTE_MAX } from '../../domain/walk-in';
import {
  OVERRIDE_REASON_MAX,
  OVERRIDE_REASON_MIN,
} from '../../../schedule-blocks/domain/reserved-slot';
import { AppointmentWriteDto } from './appointment.dto';

const TRIAGE_FLAGS_MESSAGE = `Las señales de triaje deben ser de: ${TRIAGE_FLAGS.join(', ')}.`;

/**
 * Alta mínima (DX-470): nombre, apellido y teléfono. El documento es
 * opcional; si viene y ya lo tiene otro paciente vivo de la clínica, 409
 * `PATIENT_DUPLICATE` con su id y su nombre (`existingPatient`), antes de
 * buscar hueco (la misma detección que el alta normal).
 */
export class WalkInNewPatientDto {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString({ message: 'El nombre es obligatorio.' })
  @MinLength(1, { message: 'El nombre es obligatorio.' })
  @MaxLength(100, { message: 'El nombre admite como mucho 100 caracteres.' })
  firstName!: string;

  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString({ message: 'El apellido es obligatorio.' })
  @MinLength(1, { message: 'El apellido es obligatorio.' })
  @MaxLength(100, { message: 'El apellido admite como mucho 100 caracteres.' })
  lastName!: string;

  @ApiProperty({ minLength: 5, maxLength: 40 })
  @IsString({ message: 'El teléfono es obligatorio.' })
  @MinLength(5, { message: 'Escribe un teléfono de contacto.' })
  @MaxLength(40, { message: 'El teléfono admite como mucho 40 caracteres.' })
  phone!: string;

  @ApiPropertyOptional({
    enum: DOCUMENT_TYPES,
    enumName: 'DocType',
    description: 'Tipo de documento; sin él, OTHER (como el alta sin tipo).',
  })
  @IsOptional()
  @IsIn(DOCUMENT_TYPES, {
    message: `El tipo de documento debe ser uno de: ${DOCUMENT_TYPES.join(', ')}.`,
  })
  docType?: DocumentType;

  @ApiPropertyOptional(DOC_TYPE_LABEL_PROPERTY)
  @IsOptional()
  @IsString({ message: 'docTypeLabel debe ser un texto.' })
  docTypeLabel?: string | null;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40, { message: 'El documento admite como mucho 40 caracteres.' })
  docNumber?: string;
}

// Sin sede, hora, estado ni autor: la sede sale del request (X-Location-Id,
// validada contra las sedes permitidas), la hora del reloj del servidor, el
// estado es siempre ARRIVED y el autor, el del token.
export class CreateWalkInDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Paciente existente de la clínica. Exactamente uno de `patientId` o `newPatient`.',
  })
  @IsOptional()
  @IsUUID()
  patientId?: string;

  @ApiPropertyOptional({ type: () => WalkInNewPatientDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => WalkInNewPatientDto)
  newPatient?: WalkInNewPatientDto;

  @ApiProperty({
    format: 'uuid',
    description:
      'Profesional que atiende: de esta clínica y que atiende en la sede.',
  })
  @IsUUID()
  providerId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Tipo de cita urgente (activo y con «Urgencia»). Sin él, el primer tipo urgente activo por nombre.',
  })
  @IsOptional()
  @IsUUID()
  appointmentTypeId?: string;

  @ApiPropertyOptional({
    enum: TriageFlag,
    enumName: 'TriageFlag',
    isArray: true,
    description:
      'Señales de triaje de recepción: PAIN (dolor), SWELLING (inflamación), INFECTION (infección), FEVER (fiebre), BLEEDING (sangrado), TRAUMA (traumatismo). Otro valor: 400.',
  })
  @IsOptional()
  @IsArray({ message: TRIAGE_FLAGS_MESSAGE })
  @ArrayMaxSize(TRIAGE_FLAGS.length, { message: TRIAGE_FLAGS_MESSAGE })
  @ArrayUnique({ message: 'Cada señal de triaje va una sola vez.' })
  @IsIn(TRIAGE_FLAGS, { each: true, message: TRIAGE_FLAGS_MESSAGE })
  triageFlags?: TriageFlag[];

  @ApiPropertyOptional({ maxLength: TRIAGE_NOTE_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(TRIAGE_NOTE_MAX, {
    message: `La nota de triaje admite como mucho ${TRIAGE_NOTE_MAX} caracteres.`,
  })
  triageNote?: string;

  @ApiPropertyOptional({
    minLength: OVERRIDE_REASON_MIN,
    maxLength: OVERRIDE_REASON_MAX,
    description:
      'Sobrecupo AHORA con este motivo (el mismo mecanismo que «Agendar igualmente» de DX-446: queda en `appointment_reserved_overrides`, nunca en la auditoría). Sin él, el primer hueco reservado libre de hoy o 409 `NO_RESERVED_SLOT`.',
  })
  @IsOptional()
  @IsString()
  overbookReason?: string;
}

/** La cita creada, ya en «En clínica», y qué se hizo en el paso. */
export class WalkInResultDto extends AppointmentWriteDto {
  @ApiProperty({
    description: 'Se dio de alta un paciente nuevo en el mismo paso.',
  })
  patientCreated!: boolean;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Fila del motivo del sobrecupo (`appointment_reserved_overrides`), o null.',
  })
  overbookId!: string | null;
}
