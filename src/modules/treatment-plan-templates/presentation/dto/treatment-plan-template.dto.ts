import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  PLAN_TEMPLATE_INTERVAL_DAYS_MAX,
  PLAN_TEMPLATE_LINES_MAX,
  PLAN_TEMPLATE_NAME_MAX,
  PLAN_TEMPLATE_QUANTITY_MAX,
  PLAN_TEMPLATE_VISIT_LABEL_MAX,
  PLAN_TEMPLATE_VISIT_MAX,
} from '../../domain/plan-template-rules';

const INTERVALS_DESCRIPTION = `Días mínimos entre visitas, con la misma forma que \`visitIntervals\` del plan: la clave N (de "2" a "${PLAN_TEMPLATE_VISIT_MAX}", sin pasar de la última visita de la plantilla) son los días (0 a ${PLAN_TEMPLATE_INTERVAL_DAYS_MAX}) tras la visita N-1. Al aplicar se desplazan con las visitas y no pisan los que el plan ya tenga.`;

const INTERVALS_SCHEMA = {
  type: 'object',
  additionalProperties: {
    type: 'integer',
    minimum: 0,
    maximum: PLAN_TEMPLATE_INTERVAL_DAYS_MAX,
  },
  example: { '2': 7, '3': 14 },
} as const;

/** Línea de una plantilla (respuesta). */
export class TreatmentPlanTemplateLineDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ minimum: 0, maximum: PLAN_TEMPLATE_LINES_MAX - 1 })
  position!: number;

  @ApiProperty({ format: 'uuid' })
  catalogItemId!: string;

  @ApiProperty({ example: 'Endodoncia unirradicular' })
  catalogItemLabel!: string;

  @ApiProperty({ example: 'END-01' })
  catalogItemCode!: string;

  @ApiProperty({
    description:
      'false si el procedimiento está desactivado o retirado del catálogo: al aplicar la plantilla esta línea se omite',
  })
  catalogItemActive!: boolean;

  @ApiProperty({ minimum: 1, maximum: PLAN_TEMPLATE_QUANTITY_MAX })
  quantity!: number;

  @ApiProperty({ minimum: 1, maximum: PLAN_TEMPLATE_VISIT_MAX })
  visit!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: PLAN_TEMPLATE_VISIT_LABEL_MAX,
    example: 'Conductometría',
  })
  visitLabel!: string | null;

  @ApiProperty({
    description:
      'Al aplicar, la vista previa ofrece las superficies (opcionales). El diente se pide siempre.',
  })
  asksSurfaces!: boolean;
}

/** Respuesta de los endpoints de plantillas de plan (DX-559). */
export class TreatmentPlanTemplateDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ example: 'Endodoncia + corona' })
  name!: string;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({
    minimum: 1,
    description:
      'Versión optimista: se envía de vuelta en el PATCH; sube en 1 con cada edición',
  })
  version!: number;

  @ApiProperty({ ...INTERVALS_SCHEMA, description: INTERVALS_DESCRIPTION })
  visitIntervals!: Record<string, number>;

  @ApiProperty({ type: [TreatmentPlanTemplateLineDto] })
  lines!: TreatmentPlanTemplateLineDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class PlanTemplateLineInputDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Procedimiento del catálogo de esta clínica (no un diagnóstico ni uno retirado: 422/404). Uno desactivado se admite.',
  })
  @IsUUID('all', { message: 'El procedimiento de la línea no es válido' })
  catalogItemId!: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: PLAN_TEMPLATE_QUANTITY_MAX,
    description: 'N ítems iguales al aplicar (por defecto, 1)',
  })
  @IsOptional()
  @IsInt({ message: 'La cantidad debe ser un número entero' })
  @Min(1, { message: 'La cantidad mínima es 1' })
  @Max(PLAN_TEMPLATE_QUANTITY_MAX, {
    message: `La cantidad máxima es ${PLAN_TEMPLATE_QUANTITY_MAX}`,
  })
  quantity?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: PLAN_TEMPLATE_VISIT_MAX,
    description: 'Visita de la plantilla (por defecto, 1)',
  })
  @IsOptional()
  @IsInt({ message: 'La visita debe ser un número entero' })
  @Min(1, { message: 'La visita mínima es 1' })
  @Max(PLAN_TEMPLATE_VISIT_MAX, {
    message: `La visita máxima es ${PLAN_TEMPLATE_VISIT_MAX}`,
  })
  visit?: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: PLAN_TEMPLATE_VISIT_LABEL_MAX,
    description:
      'Etiqueta de la visita; todas las líneas de una visita llevan la misma',
  })
  @IsOptional()
  @IsString()
  @MaxLength(PLAN_TEMPLATE_VISIT_LABEL_MAX, {
    message: `La etiqueta de visita no puede tener más de ${PLAN_TEMPLATE_VISIT_LABEL_MAX} caracteres`,
  })
  visitLabel?: string | null;

  @ApiPropertyOptional({
    description: 'Si al aplicar se ofrecen las superficies (por defecto, no)',
  })
  @IsOptional()
  @IsBoolean()
  asksSurfaces?: boolean;
}

// Sin `tenantId`: sale del contexto del request.
export class CreateTreatmentPlanTemplateDto {
  @ApiProperty({ minLength: 1, maxLength: PLAN_TEMPLATE_NAME_MAX })
  @IsString({ message: 'El nombre de la plantilla es obligatorio' })
  @MaxLength(PLAN_TEMPLATE_NAME_MAX, {
    message: `El nombre de la plantilla no puede tener más de ${PLAN_TEMPLATE_NAME_MAX} caracteres`,
  })
  name!: string;

  @ApiPropertyOptional({
    ...INTERVALS_SCHEMA,
    description: INTERVALS_DESCRIPTION,
  })
  @IsOptional()
  @IsObject({ message: 'Los días entre visitas deben ser un objeto' })
  visitIntervals?: Record<string, number>;

  @ApiProperty({
    type: [PlanTemplateLineInputDto],
    minItems: 1,
    maxItems: PLAN_TEMPLATE_LINES_MAX,
  })
  @IsArray({ message: 'Las líneas deben ser una lista' })
  @ArrayMinSize(1, {
    message: 'La plantilla necesita al menos un procedimiento',
  })
  @ArrayMaxSize(PLAN_TEMPLATE_LINES_MAX, {
    message: `Una plantilla admite como máximo ${PLAN_TEMPLATE_LINES_MAX} procedimientos`,
  })
  @ValidateNested({ each: true })
  @Type(() => PlanTemplateLineInputDto)
  lines!: PlanTemplateLineInputDto[];

  @ApiPropertyOptional({ description: 'Por defecto, true' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateTreatmentPlanTemplateDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: PLAN_TEMPLATE_NAME_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(PLAN_TEMPLATE_NAME_MAX, {
    message: `El nombre de la plantilla no puede tener más de ${PLAN_TEMPLATE_NAME_MAX} caracteres`,
  })
  name?: string;

  @ApiPropertyOptional({
    ...INTERVALS_SCHEMA,
    description: INTERVALS_DESCRIPTION,
  })
  @IsOptional()
  @IsObject({ message: 'Los días entre visitas deben ser un objeto' })
  visitIntervals?: Record<string, number>;

  @ApiPropertyOptional({
    type: [PlanTemplateLineInputDto],
    minItems: 1,
    maxItems: PLAN_TEMPLATE_LINES_MAX,
    description: 'Si viene, sustituye todas las líneas',
  })
  @IsOptional()
  @IsArray({ message: 'Las líneas deben ser una lista' })
  @ArrayMinSize(1, {
    message: 'La plantilla necesita al menos un procedimiento',
  })
  @ArrayMaxSize(PLAN_TEMPLATE_LINES_MAX, {
    message: `Una plantilla admite como máximo ${PLAN_TEMPLATE_LINES_MAX} procedimientos`,
  })
  @ValidateNested({ each: true })
  @Type(() => PlanTemplateLineInputDto)
  lines?: PlanTemplateLineInputDto[];

  @ApiPropertyOptional({
    description: 'false = desactivarla (sale del selector del plan)',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiProperty({
    minimum: 1,
    description:
      'Versión que el cliente leyó (la `version` de la plantilla). Si ya cambió: 409 `code` PLAN_TEMPLATE_STALE. Obligatoria.',
  })
  @IsInt({ message: 'Falta la versión de la plantilla: recárgala' })
  @Min(1, { message: 'Falta la versión de la plantilla: recárgala' })
  version!: number;
}

export class ListTreatmentPlanTemplatesQueryDto {
  @ApiPropertyOptional({
    description:
      'true = también las desactivadas (Ajustes). Por defecto, solo las activas.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}
