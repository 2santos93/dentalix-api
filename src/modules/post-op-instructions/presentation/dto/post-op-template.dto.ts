import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { POSTOP_VARIABLES } from '../../domain/render-instructions';
import type { PostOpTemplateView } from '../../domain/ports/post-op-template-repository.port';

// Mismos topes que el CHECK post_op_instruction_templates_lengths_check.
export const POSTOP_TITLE_MAX = 200;
export const POSTOP_BODY_MAX = 20000;
export const POSTOP_LINKS_MAX = 50;

const VARIABLES_DOC = `Variables admitidas: ${POSTOP_VARIABLES.map((v) => `{{${v}}}`).join(', ')}. Otra variable da 400.`;

function TitleRules(): PropertyDecorator {
  return applyDecorators(
    IsString({ message: 'El título debe ser un texto.' }),
    MinLength(1, { message: 'El título no puede estar vacío.' }),
    MaxLength(POSTOP_TITLE_MAX, {
      message: `El título admite hasta ${POSTOP_TITLE_MAX} caracteres.`,
    }),
  );
}

function BodyRules(): PropertyDecorator {
  return applyDecorators(
    IsString({ message: 'El texto debe ser un texto.' }),
    MinLength(1, { message: 'El texto no puede estar vacío.' }),
    MaxLength(POSTOP_BODY_MAX, {
      message: `El texto admite hasta ${POSTOP_BODY_MAX} caracteres.`,
    }),
  );
}

/** Vínculos: al editar, cada lista que llega reemplaza la anterior completa. */
class PostOpTemplateLinksDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: POSTOP_LINKS_MAX,
    description:
      'Procedimientos del catálogo (kind PROCEDURE) que sugieren esta plantilla. Al editar, reemplaza la lista completa.',
  })
  @IsOptional()
  @IsArray({ message: 'catalogItemIds debe ser una lista.' })
  @ArrayMaxSize(POSTOP_LINKS_MAX, {
    message: `Admite hasta ${POSTOP_LINKS_MAX} procedimientos.`,
  })
  @IsUUID('4', { each: true, message: 'Cada procedimiento debe ser un UUID.' })
  catalogItemIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: POSTOP_LINKS_MAX,
    description:
      'Tipos de cita que sugieren esta plantilla. Al editar, reemplaza la lista completa.',
  })
  @IsOptional()
  @IsArray({ message: 'appointmentTypeIds debe ser una lista.' })
  @ArrayMaxSize(POSTOP_LINKS_MAX, {
    message: `Admite hasta ${POSTOP_LINKS_MAX} tipos de cita.`,
  })
  @IsUUID('4', { each: true, message: 'Cada tipo de cita debe ser un UUID.' })
  appointmentTypeIds?: string[];
}

// Sin `tenantId` ni `version`: salen del contexto y del servidor.
export class CreatePostOpTemplateDto extends PostOpTemplateLinksDto {
  @ApiProperty({
    example: 'POI-EXO',
    description:
      'De 2 a 20 letras, números o guiones; se guarda en mayúsculas (400 si no). Único en la clínica (409) y no se edita después.',
  })
  @IsString({ message: 'El código debe ser un texto.' })
  code!: string;

  @ApiProperty({ minLength: 1, maxLength: POSTOP_TITLE_MAX })
  @TitleRules()
  title!: string;

  @ApiProperty({
    minLength: 1,
    maxLength: POSTOP_BODY_MAX,
    description: VARIABLES_DOC,
  })
  @BodyRules()
  body!: string;
}

// Edición parcial; `code` no está (whitelist lo descarta). Cambiar título o
// texto sube `version`; las entregas ya hechas guardan su propia copia.
export class UpdatePostOpTemplateDto extends PostOpTemplateLinksDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: POSTOP_TITLE_MAX })
  @IsOptional()
  @TitleRules()
  title?: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: POSTOP_BODY_MAX,
    description: VARIABLES_DOC,
  })
  @IsOptional()
  @BodyRules()
  body?: string;

  @ApiPropertyOptional({ description: 'false = desactivar la plantilla' })
  @IsOptional()
  @IsBoolean({ message: 'active debe ser verdadero o falso.' })
  active?: boolean;
}

export class ListPostOpTemplatesQueryDto {
  @ApiPropertyOptional({
    description: 'true = solo activas; false = solo inactivas; sin él, todas',
  })
  @IsOptional()
  // `Boolean('false')` sería `true`.
  @Transform(({ value }: { value: unknown }) =>
    value === undefined ? undefined : value === true || value === 'true',
  )
  @IsBoolean()
  active?: boolean;
}

export class PostOpTemplateCatalogItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() labelEs!: string;
}

export class PostOpTemplateAppointmentTypeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

// Respuesta de /post-op-templates (DX-222).
export class PostOpTemplateDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'POI-EXO' }) code!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ description: VARIABLES_DOC }) body!: string;
  @ApiProperty({
    description:
      'Sube en 1 con cada cambio de título o texto. La entrega guarda la versión de la que salió.',
  })
  version!: number;
  @ApiProperty() active!: boolean;
  @ApiProperty({ type: [PostOpTemplateCatalogItemDto] })
  catalogItems!: PostOpTemplateCatalogItemDto[];
  @ApiProperty({ type: [PostOpTemplateAppointmentTypeDto] })
  appointmentTypes!: PostOpTemplateAppointmentTypeDto[];
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
}

/** Solo los campos del contrato: ni `tenantId`, ni autores, ni ids de vínculo. */
export function toPostOpTemplateDto(
  view: PostOpTemplateView,
): PostOpTemplateDto {
  return {
    id: view.id,
    code: view.code,
    title: view.title,
    body: view.body,
    version: view.version,
    active: view.active,
    catalogItems: view.catalogItems,
    appointmentTypes: view.appointmentTypes,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}
