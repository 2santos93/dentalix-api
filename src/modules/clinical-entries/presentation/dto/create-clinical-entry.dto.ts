import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  NOTE_ANSWER_TEXT_MAX,
  NOTE_PROMPT_OPTIONS_MAX,
  NOTE_PROMPTS_MAX,
} from '../../../clinical-note-templates/domain/note-template-rules';

/** DX-170: respuesta a una pregunta de la plantilla. */
export class ClinicalEntryAnswerDto {
  @ApiProperty({ format: 'uuid', description: 'Pregunta de la plantilla' })
  @IsUUID('all', { message: 'promptId debe ser el id de una pregunta' })
  promptId!: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'ONE: una opción; MULTI: varias opciones; TEXT: un texto. Vacío = sin respuesta.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(NOTE_PROMPT_OPTIONS_MAX)
  @IsString({ each: true })
  @MaxLength(NOTE_ANSWER_TEXT_MAX, {
    each: true,
    message: `Una respuesta admite como máximo ${NOTE_ANSWER_TEXT_MAX} caracteres`,
  })
  values?: string[];

  @ApiPropertyOptional({
    description: '«Omitir»: el hueco queda marcado «[sin respuesta]»',
  })
  @IsOptional()
  @IsBoolean()
  skipped?: boolean;
}

// NOTE: deliberately NO `tenantId`/`patientId`/`performedById` field —
// tenant comes from the guarded request context, `patientId` from the route
// param, and `performedById` from `req.user.sub` (same convention as
// CreatePatientDto / SaveMedicalHistoryDto).
export class CreateClinicalEntryDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'Fecha de atención. Si falta: la de la cita ligada o, sin cita, ahora.',
  })
  @IsOptional()
  @IsDateString()
  entryDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({
    minLength: 1,
    description:
      'Texto final de la evolución. Obligatorio sin plantilla; con plantilla, el texto compuesto ya revisado (y quizá editado). Si falta, el servidor lo compone con `answers`.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'El texto de la evolución no puede estar vacío' })
  notes?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'DX-170: cita en la que se documenta. Tiene que ser de esta clínica (404), de este paciente (400) y no de un día futuro en la zona de su sede (400).',
  })
  @IsOptional()
  @IsUUID('all', { message: 'appointmentId debe ser el id de una cita' })
  appointmentId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'DX-170: plantilla de evolución de la clínica, activa.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'templateId debe ser el id de una plantilla' })
  templateId?: string;

  @ApiPropertyOptional({
    type: [ClinicalEntryAnswerDto],
    description:
      'DX-170: respuestas a las preguntas de la plantilla, para que el servidor componga el texto (sin `notes`). Una pregunta sin respuesta toma su valor por defecto.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(NOTE_PROMPTS_MAX)
  @ValidateNested({ each: true })
  @Type(() => ClinicalEntryAnswerDto)
  answers?: ClinicalEntryAnswerDto[];
}
