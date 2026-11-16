import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import { PriceSource, ToothSurface } from '@prisma/client';
import { INPUT_SURFACES_MAX } from '../../../../shared/validation/input-limits';
import { FDI_TOOTH_NUMBER_PATTERN } from '../../../odontogram/application/use-cases/add-tooth-record.use-case';
import { CurrencyDigitsDto } from '../../../reference/presentation/dto/currency.dto';
import { PLAN_TEMPLATE_LINES_MAX } from '../../../treatment-plan-templates/domain/plan-template-rules';
import { TreatmentPlanItemDto } from './treatment-plan-item.dto';
import { TreatmentPlanDto } from './treatment-plan.dto';

const TOOTH_MESSAGE =
  'El número de diente debe ser un código FDI válido (permanentes 11-18/21-28/31-38/41-48 o temporales 51-55/61-65/71-75/81-85).';

export class PreviewPlanTemplateDto {
  @ApiProperty({ format: 'uuid', description: 'Plantilla de esta clínica' })
  @IsUUID('all', { message: 'La plantilla no es válida' })
  templateId!: string;
}

export class TemplateLineChoiceDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Una línea de la plantilla (`lines[].lineId` de la vista previa)',
  })
  @IsUUID('all', { message: 'La línea de la plantilla no es válida' })
  lineId!: string;

  @ApiPropertyOptional({
    pattern: FDI_TOOTH_NUMBER_PATTERN.source,
    example: '36',
    description: 'Diente de esta línea; gana al común',
  })
  @IsOptional()
  @IsString()
  @Matches(FDI_TOOTH_NUMBER_PATTERN, { message: TOOTH_MESSAGE })
  toothNumber?: string;

  @ApiPropertyOptional({
    enum: ToothSurface,
    isArray: true,
    description:
      'Superficies (opcionales); solo se guardan en las líneas con `asksSurfaces`',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(ToothSurface, { each: true })
  @ArrayMaxSize(INPUT_SURFACES_MAX)
  surfaces?: ToothSurface[];
}

export class ApplyPlanTemplateDto extends PreviewPlanTemplateDto {
  @ApiPropertyOptional({
    pattern: FDI_TOOTH_NUMBER_PATTERN.source,
    example: '36',
    description:
      'Diente para todas las líneas (D2). Toda línea aplicable necesita diente: el suyo o este; sin ninguno, 400 PLAN_TEMPLATE_TOOTH_REQUIRED y no se crea nada.',
  })
  @IsOptional()
  @IsString()
  @Matches(FDI_TOOTH_NUMBER_PATTERN, { message: TOOTH_MESSAGE })
  toothNumber?: string;

  @ApiPropertyOptional({
    type: [TemplateLineChoiceDto],
    maxItems: PLAN_TEMPLATE_LINES_MAX,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PLAN_TEMPLATE_LINES_MAX)
  @ValidateNested({ each: true })
  @Type(() => TemplateLineChoiceDto)
  lines?: TemplateLineChoiceDto[];
}

export class TemplatePreviewLineDto {
  @ApiProperty({ format: 'uuid' })
  lineId!: string;

  @ApiProperty({ minimum: 0 })
  position!: number;

  @ApiProperty({ format: 'uuid' })
  catalogItemId!: string;

  @ApiProperty({ example: 'Endodoncia unirradicular' })
  catalogItemLabel!: string;

  @ApiProperty({ example: 'END-01' })
  catalogItemCode!: string;

  @ApiProperty({ minimum: 1, maximum: 20 })
  quantity!: number;

  @ApiProperty({ minimum: 1, description: 'Visita de la plantilla' })
  templateVisit!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Visita del plan a la que va (detrás de la última visita viva del plan); null si la línea se omite',
  })
  targetVisit!: number | null;

  @ApiProperty({ type: String, nullable: true })
  visitLabel!: string | null;

  @ApiProperty({
    description:
      'Ofrecer las superficies (opcionales). El diente se pide siempre.',
  })
  asksSurfaces!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Precio unitario vigente para este paciente en la moneda del plan (convenio, lista de la sede o catálogo), sin descuento; null sin precio u omitida',
  })
  unitPrice!: number | null;

  @ApiProperty({ enum: PriceSource, nullable: true })
  priceSource!: PriceSource | null;

  @ApiProperty({ type: String, nullable: true })
  agreementName!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '`unitPrice × quantity`; null sin precio u omitida',
  })
  lineTotal!: number | null;

  @ApiProperty({
    description:
      'Sin precio en la moneda del plan (o sin la tasa del día): aplicar daría 422',
  })
  priceMissing!: boolean;

  @ApiProperty({
    type: String,
    enum: ['NO_PRICE', 'RATE_MISSING'],
    nullable: true,
    description:
      'NO_PRICE: ni convenio, ni lista de la sede, ni precio de catálogo; RATE_MISSING: el precio está en otra moneda y falta la tasa de hoy',
  })
  priceIssue!: 'NO_PRICE' | 'RATE_MISSING' | null;

  @ApiProperty({
    type: String,
    enum: ['CATALOG_ITEM_INACTIVE'],
    nullable: true,
    description:
      'CATALOG_ITEM_INACTIVE: el procedimiento está desactivado o retirado del catálogo; al aplicar se omite',
  })
  skipped!: 'CATALOG_ITEM_INACTIVE' | null;
}

export class TemplatePreviewDto {
  @ApiProperty({ format: 'uuid' })
  planId!: string;

  @ApiProperty({ format: 'uuid' })
  templateId!: string;

  @ApiProperty({ minimum: 1 })
  templateVersion!: number;

  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({ type: CurrencyDigitsDto })
  currencyDigits!: CurrencyDigitsDto;

  @ApiProperty({
    minimum: 0,
    description: 'La mayor visita viva del plan (0 si no tiene ítems)',
  })
  visitOffset!: number;

  @ApiProperty({ type: [TemplatePreviewLineDto] })
  lines!: TemplatePreviewLineDto[];

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer', minimum: 0, maximum: 3650 },
    description:
      'Los intervalos del plan tal como quedarían (los de la plantilla desplazados, sin pisar los que el plan ya tiene)',
  })
  visitIntervals!: Record<string, number>;

  @ApiProperty({
    minimum: 0,
    description: 'Ítems que se crearían (líneas aplicables × cantidad)',
  })
  itemCount!: number;

  @ApiProperty({ description: 'Suma de las líneas con precio' })
  total!: number;
}

export class SkippedTemplateLineDto {
  @ApiProperty({ format: 'uuid' })
  lineId!: string;

  @ApiProperty({ format: 'uuid' })
  catalogItemId!: string;

  @ApiProperty()
  catalogItemLabel!: string;

  @ApiProperty({ type: String, enum: ['CATALOG_ITEM_INACTIVE'] })
  reason!: 'CATALOG_ITEM_INACTIVE';
}

export class TemplateApplicationDto {
  @ApiProperty({
    type: TreatmentPlanDto,
    description:
      'El plan tal como queda (como GET /treatment-plans/:id: ítems, total, `visitIntervals`, `quoteExpired` y `currencyDigits`)',
  })
  plan!: TreatmentPlanDto;

  @ApiProperty({
    type: [TreatmentPlanItemDto],
    description: 'Los ítems creados, en el orden de la plantilla',
  })
  createdItems!: TreatmentPlanItemDto[];

  @ApiProperty({ type: [SkippedTemplateLineDto] })
  skipped!: SkippedTemplateLineDto[];
}
