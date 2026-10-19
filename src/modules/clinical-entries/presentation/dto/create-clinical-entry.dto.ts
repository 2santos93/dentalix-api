import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ClinicalDiagnosisKind } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
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

/** DX-212: diagnóstico CIE-10 de la evolución. */
export class ClinicalEntryDiagnosisInputDto {
  @ApiProperty({
    example: 'K02.1',
    description:
      'Código CIE-10 (con o sin punto). Tiene que existir en GET /reference/icd10; si no, 400 «Código CIE-10 no válido».',
  })
  @IsString()
  @MaxLength(10, { message: 'Código CIE-10 no válido' })
  icd10Code!: string;

  @ApiProperty({
    enum: ClinicalDiagnosisKind,
    enumName: 'ClinicalDiagnosisKind',
  })
  @IsEnum(ClinicalDiagnosisKind, {
    message: 'El tipo de diagnóstico debe ser PRINCIPAL o RELACIONADO',
  })
  kind!: ClinicalDiagnosisKind;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '36',
    description: 'Diente FDI (opcional).',
  })
  @IsOptional()
  @IsString()
  toothFdi?: string | null;
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
      'Fecha de atención (fecha civil). Si falta: el día de la cita ligada en la zona de su sede o, sin cita, ahora.',
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

  @ApiPropertyOptional({
    type: [ClinicalEntryDiagnosisInputDto],
    maxItems: 4,
    description:
      'DX-212: diagnósticos CIE-10, guardados en la misma transacción e inalterables. Como máximo 1 PRINCIPAL y 3 RELACIONADO (400 en español si no); los relacionados exigen el principal. Opcional: sin diagnóstico la evolución se guarda igual.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => ClinicalEntryDiagnosisInputDto)
  diagnoses?: ClinicalEntryDiagnosisInputDto[];
}
