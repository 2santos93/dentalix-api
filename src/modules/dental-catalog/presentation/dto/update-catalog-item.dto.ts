import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import {
  INPUT_CODE_MAX,
  INPUT_NAME_MAX,
  INPUT_SHORT_TEXT_MAX,
  TextMaxLength,
} from '../../../../shared/validation/input-limits';
import { CatalogKind } from '@prisma/client';
import { NoteTemplateLinkField } from './note-template-link.field';
import {
  PatientDescriptionDto,
  PatientDescriptionField,
} from './patient-description.dto';
import {
  HEX_COLOR_PATTERN,
  POST_OP_CHECK_AFTER_DAYS_MAX,
  POST_OP_CHECK_AFTER_DAYS_MESSAGE,
  POST_OP_CHECK_AFTER_DAYS_MIN,
} from '../../application/use-cases/create-catalog-item.use-case';
import {
  IsNonNegativeMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';

// All fields optional (partial update). NO `tenantId` field — same rationale
// as CreateCatalogItemDto: tenant scoping comes from the guarded request context.
export class UpdateCatalogItemDto {
  @ApiPropertyOptional({ minLength: 1 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @TextMaxLength(INPUT_CODE_MAX)
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_NAME_MAX)
  category?: string;

  @ApiPropertyOptional({ enum: CatalogKind })
  @IsOptional()
  @IsEnum(CatalogKind)
  kind?: CatalogKind;

  @ApiPropertyOptional({ minLength: 1 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @TextMaxLength(INPUT_SHORT_TEXT_MAX)
  labelEs?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_SHORT_TEXT_MAX)
  labelEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_SHORT_TEXT_MAX)
  labelPt?: string;

  @ApiPropertyOptional({
    description: 'Hex color (e.g. #1A2B3C)',
    pattern: HEX_COLOR_PATTERN.source,
  })
  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_PATTERN, {
    message: 'El color debe ser un valor hexadecimal válido (p. ej., #1A2B3C).',
  })
  color?: string;

  @ApiPropertyOptional({
    description: 'At most 2 decimal places',
    maximum: MONEY_MAX,
  })
  @IsOptional()
  @IsNonNegativeMoney()
  defaultPrice?: number;

  @ApiPropertyOptional({
    description: 'DX-105: false = la prestación no admite descuentos.',
  })
  @IsOptional()
  @IsBoolean()
  allowDiscount?: boolean;

  @ApiPropertyOptional({
    description:
      'DX-566: al marcarlo hecho se crea un control postoperatorio (llamada al paciente). Solo en PROCEDURE: en un diagnóstico, 400. Un procedimiento que pasa a diagnóstico deja de pedirlo.',
  })
  @IsOptional()
  @IsBoolean()
  requiresPostOpCheck?: boolean;

  @ApiPropertyOptional({
    minimum: POST_OP_CHECK_AFTER_DAYS_MIN,
    maximum: POST_OP_CHECK_AFTER_DAYS_MAX,
    description:
      'DX-566: días HÁBILES de la sede tras el procedimiento en los que se llama (1–30).',
  })
  @IsOptional()
  @IsInt({ message: POST_OP_CHECK_AFTER_DAYS_MESSAGE })
  @Min(POST_OP_CHECK_AFTER_DAYS_MIN, {
    message: POST_OP_CHECK_AFTER_DAYS_MESSAGE,
  })
  @Max(POST_OP_CHECK_AFTER_DAYS_MAX, {
    message: POST_OP_CHECK_AFTER_DAYS_MESSAGE,
  })
  postOpCheckAfterDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @NoteTemplateLinkField()
  clinicalNoteTemplateId?: string | null;

  @PatientDescriptionField()
  patientDescription?: PatientDescriptionDto[];
}
