import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ClinicalNotePromptType } from '@prisma/client';
import {
  NOTE_PROMPT_DEFAULT_MAX,
  NOTE_PROMPT_LABEL_MAX,
  NOTE_PROMPT_OPTION_MAX,
  NOTE_PROMPT_OPTIONS_MAX,
  NOTE_PROMPTS_MAX,
  NOTE_TEMPLATE_BODY_MAX,
  NOTE_TEMPLATE_CATEGORY_MAX,
  NOTE_TEMPLATE_NAME_MAX,
} from '../../domain/note-template-rules';
import {
  NOTE_SHORTCUT_FORMAT_MESSAGE,
  NOTE_SHORTCUT_MAX,
  NOTE_SHORTCUT_MIN,
} from '../../domain/note-template-shortcut';

const SHORTCUT_DESCRIPTION =
  'DX-455: atajo para insertar la plantilla escribiendo en la nota: «#» y de 2 a 30 letras (cualquier alfabeto, con tildes), números, «-» o «_», sin espacios. Se guarda tal como se escribe y se compara sin distinguir mayúsculas. Único por clínica (también frente a las desactivadas, que conservan el suyo) y ninguno puede empezar por otro (#re choca con #resina): 409 con `code` NOTE_SHORTCUT_CONFLICT. null o "" = sin atajo.';

/**
 * El formato fino (letras de cualquier alfabeto) lo valida el caso de uso tras
 * recortar y normalizar a NFC; aquí solo el tipo y un tope holgado.
 */
function ShortcutField(): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({
      type: String,
      nullable: true,
      minLength: NOTE_SHORTCUT_MIN + 1,
      maxLength: NOTE_SHORTCUT_MAX + 1,
      example: '#resina',
      description: SHORTCUT_DESCRIPTION,
    }),
    IsOptional(),
    IsString({ message: NOTE_SHORTCUT_FORMAT_MESSAGE }),
    MaxLength(NOTE_SHORTCUT_MAX + 10, {
      message: NOTE_SHORTCUT_FORMAT_MESSAGE,
    }),
  );
}

const PROMPT_TYPES = Object.values(ClinicalNotePromptType);

/** Pregunta de una plantilla (respuesta). */
export class ClinicalNoteTemplatePromptDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    maxLength: NOTE_PROMPT_LABEL_MAX,
    description: 'Etiqueta; también es el marcador del texto: {{Etiqueta}}',
    example: 'Superficie',
  })
  label!: string;

  @ApiProperty({ enum: PROMPT_TYPES, enumName: 'ClinicalNotePromptType' })
  type!: ClinicalNotePromptType;

  @ApiProperty({ type: [String], example: ['O', 'M', 'D', 'V', 'L'] })
  options!: string[];

  @ApiProperty({ type: String, nullable: true })
  defaultValue!: string | null;

  @ApiProperty({ minimum: 0 })
  position!: number;
}

/** Respuesta de los endpoints de plantillas de evolución (DX-170). */
export class ClinicalNoteTemplateDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ example: 'Resina' })
  name!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Operatoria' })
  category!: string | null;

  @ApiProperty({
    example: 'Resina en superficie {{Superficie}} con {{Material}}.',
  })
  body!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '#resina',
    description:
      'DX-455: atajo («#resina») tal como se escribió; null = sin atajo. Se compara sin distinguir mayúsculas.',
  })
  shortcut!: string | null;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({
    minimum: 1,
    description:
      'Versión optimista: se envía de vuelta en el PATCH; sube en 1 con cada edición',
  })
  version!: number;

  @ApiProperty({ type: [ClinicalNoteTemplatePromptDto] })
  prompts!: ClinicalNoteTemplatePromptDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

const PROMPT_TYPE_MESSAGE = 'El tipo de pregunta debe ser ONE, MULTI o TEXT';

export class NotePromptInputDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Id de la pregunta existente que se conserva al editar (upsert por id). Sin id, o con uno que no es de la plantilla, es una pregunta nueva.',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ minLength: 1, maxLength: NOTE_PROMPT_LABEL_MAX })
  @IsString({ message: 'Cada pregunta necesita una etiqueta' })
  @MaxLength(NOTE_PROMPT_LABEL_MAX, {
    message: `La etiqueta de una pregunta no puede tener más de ${NOTE_PROMPT_LABEL_MAX} caracteres`,
  })
  label!: string;

  @ApiProperty({ enum: PROMPT_TYPES, enumName: 'ClinicalNotePromptType' })
  @IsIn(PROMPT_TYPES, { message: PROMPT_TYPE_MESSAGE })
  type!: ClinicalNotePromptType;

  @ApiPropertyOptional({
    type: [String],
    maxItems: NOTE_PROMPT_OPTIONS_MAX,
    description: 'Obligatorias (1 a 20) en ONE y MULTI; vacías en TEXT',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(NOTE_PROMPT_OPTIONS_MAX, {
    message: `Una pregunta admite como máximo ${NOTE_PROMPT_OPTIONS_MAX} opciones`,
  })
  @IsString({ each: true })
  @MaxLength(NOTE_PROMPT_OPTION_MAX, {
    each: true,
    message: `Cada opción admite como máximo ${NOTE_PROMPT_OPTION_MAX} caracteres`,
  })
  options?: string[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: NOTE_PROMPT_DEFAULT_MAX,
    description: 'En ONE y MULTI, una de las opciones',
  })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_PROMPT_DEFAULT_MAX)
  defaultValue?: string | null;
}

// Sin `tenantId`: sale del contexto del request.
export class CreateClinicalNoteTemplateDto {
  @ApiProperty({ minLength: 1, maxLength: NOTE_TEMPLATE_NAME_MAX })
  @IsString({ message: 'El nombre de la plantilla es obligatorio' })
  @MaxLength(NOTE_TEMPLATE_NAME_MAX, {
    message: `El nombre de la plantilla no puede tener más de ${NOTE_TEMPLATE_NAME_MAX} caracteres`,
  })
  name!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: NOTE_TEMPLATE_CATEGORY_MAX,
    description: 'Carpeta del selector (p. ej. «Operatoria»)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_TEMPLATE_CATEGORY_MAX, {
    message: `La carpeta no puede tener más de ${NOTE_TEMPLATE_CATEGORY_MAX} caracteres`,
  })
  category?: string | null;

  @ApiProperty({
    minLength: 1,
    maxLength: NOTE_TEMPLATE_BODY_MAX,
    description:
      'Texto fijo con marcadores {{Etiqueta}}; cada marcador necesita una pregunta con esa etiqueta y cada pregunta su marcador',
  })
  @IsString({ message: 'El texto de la plantilla es obligatorio' })
  @MaxLength(NOTE_TEMPLATE_BODY_MAX, {
    message: `El texto de la plantilla no puede tener más de ${NOTE_TEMPLATE_BODY_MAX} caracteres`,
  })
  body!: string;

  @ApiProperty({ type: [NotePromptInputDto], maxItems: NOTE_PROMPTS_MAX })
  @IsArray({ message: 'Las preguntas deben ser una lista' })
  @ArrayMaxSize(NOTE_PROMPTS_MAX, {
    message: `Una plantilla admite como máximo ${NOTE_PROMPTS_MAX} preguntas`,
  })
  @ValidateNested({ each: true })
  @Type(() => NotePromptInputDto)
  prompts!: NotePromptInputDto[];

  @ApiPropertyOptional({ description: 'Por defecto, true' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ShortcutField()
  shortcut?: string | null;
}

export class UpdateClinicalNoteTemplateDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: NOTE_TEMPLATE_NAME_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_TEMPLATE_NAME_MAX, {
    message: `El nombre de la plantilla no puede tener más de ${NOTE_TEMPLATE_NAME_MAX} caracteres`,
  })
  name?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: NOTE_TEMPLATE_CATEGORY_MAX,
  })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_TEMPLATE_CATEGORY_MAX, {
    message: `La carpeta no puede tener más de ${NOTE_TEMPLATE_CATEGORY_MAX} caracteres`,
  })
  category?: string | null;

  @ApiPropertyOptional({ minLength: 1, maxLength: NOTE_TEMPLATE_BODY_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_TEMPLATE_BODY_MAX, {
    message: `El texto de la plantilla no puede tener más de ${NOTE_TEMPLATE_BODY_MAX} caracteres`,
  })
  body?: string;

  @ApiPropertyOptional({
    type: [NotePromptInputDto],
    maxItems: NOTE_PROMPTS_MAX,
    description: 'Si viene, sustituye todas las preguntas',
  })
  @IsOptional()
  @IsArray({ message: 'Las preguntas deben ser una lista' })
  @ArrayMaxSize(NOTE_PROMPTS_MAX, {
    message: `Una plantilla admite como máximo ${NOTE_PROMPTS_MAX} preguntas`,
  })
  @ValidateNested({ each: true })
  @Type(() => NotePromptInputDto)
  prompts?: NotePromptInputDto[];

  @ApiPropertyOptional({
    description: 'false = desactivarla (sale del selector)',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ShortcutField()
  shortcut?: string | null;

  @ApiProperty({
    minimum: 1,
    description:
      'Versión que el cliente leyó (la `version` de la plantilla). Si la plantilla ya cambió: 409 «La plantilla cambió, recárgala». Obligatoria.',
  })
  @IsInt({ message: 'Falta la versión de la plantilla: recárgala' })
  @Min(1, { message: 'Falta la versión de la plantilla: recárgala' })
  version!: number;
}

export class ListClinicalNoteTemplatesQueryDto {
  @ApiPropertyOptional({
    description:
      'true = también las desactivadas (Ajustes). Por defecto, solo las activas.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}
