import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { AnesthesiaTechnique } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  OVERRIDE_REASON_MAX,
  OVERRIDE_REASON_MIN,
} from '../../application/use-cases/anesthesia.use-cases';
import { CARPULES_MAX } from '../../domain/anesthesia-dose';

const NUMBER = { maxDecimalPlaces: 2 };

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

export class AnestheticProductDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Lidocaína 2 % con epinefrina 1:100.000' })
  name!: string;
  @ApiProperty({ example: 'Lidocaína' }) activeIngredient!: string;
  @ApiProperty({ example: 2, description: 'Concentración en %' })
  concentrationPct!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Epinefrina 1:100.000',
  })
  vasoconstrictor!: string | null;
  @ApiProperty({ example: 1.8 }) mlPerCarpule!: number;
  @ApiProperty({ example: 7 }) maxMgPerKg!: number;
  @ApiProperty({ example: 500, description: 'Tope absoluto en mg' })
  maxAbsoluteMg!: number;
  @ApiProperty({ type: String, nullable: true, example: 'LIDOCAINE_2_EPI' })
  sampleCode!: string | null;
  @ApiProperty() active!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}

export class CreateAnestheticProductDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  activeIngredient!: string;

  @ApiProperty({ minimum: 0.01, maximum: 10 })
  @IsNumber(NUMBER)
  @Min(0.01)
  @Max(10)
  concentrationPct!: number;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  vasoconstrictor!: string | null;

  @ApiProperty({ minimum: 0.1, maximum: 5 })
  @IsNumber(NUMBER)
  @Min(0.1)
  @Max(5)
  mlPerCarpule!: number;

  @ApiProperty({ minimum: 0.1, maximum: 20 })
  @IsNumber(NUMBER)
  @Min(0.1)
  @Max(20)
  maxMgPerKg!: number;

  @ApiProperty({ minimum: 1, maximum: 2000 })
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(1)
  @Max(2000)
  maxAbsoluteMg!: number;
}

export class UpdateAnestheticProductDto extends PartialType(
  CreateAnestheticProductDto,
) {
  @ApiPropertyOptional({ description: 'false = desactivado (no se borra)' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ListAnestheticsQueryDto {
  @ApiPropertyOptional({
    description: 'true = también los desactivados (Ajustes)',
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeInactive?: boolean;
}

// ---------------------------------------------------------------------------
// Anestesia de una evolución
// ---------------------------------------------------------------------------

export class AnesthesiaDoseCheckDto {
  @ApiProperty({ format: 'uuid', description: 'Anestésico del catálogo' })
  @IsUUID()
  anestheticId!: string;

  @ApiProperty({
    minimum: 0.25,
    maximum: CARPULES_MAX,
    multipleOf: 0.25,
    example: 1.5,
  })
  @IsNumber(NUMBER)
  @Min(0.25)
  @Max(CARPULES_MAX)
  carpules!: number;

  @ApiPropertyOptional({
    minimum: 0.1,
    maximum: 399,
    description:
      'Peso anotado en el sillón (kg). Sin él: el último pesado en el sillón en esta evolución; si no, el de la valoración de sedación de esta evolución; si no, el de la anamnesis vigente; si no, el ya usado en esta evolución.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0.1)
  @Max(399)
  weightKg?: number;
}

export class RecordAnesthesiaDto extends AnesthesiaDoseCheckDto {
  @ApiProperty({ enum: AnesthesiaTechnique, enumName: 'AnesthesiaTechnique' })
  @IsEnum(AnesthesiaTechnique)
  technique!: AnesthesiaTechnique;

  @ApiPropertyOptional({ maxLength: 120, description: 'Zona o dientes FDI' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  site?: string;

  @ApiPropertyOptional({ maxLength: 60, description: 'Lote del carpule' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  lot?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Hora de la administración; por defecto, ahora',
  })
  @IsOptional()
  @IsDateString()
  administeredAt?: string;

  @ApiPropertyOptional({
    minLength: OVERRIDE_REASON_MIN,
    maxLength: OVERRIDE_REASON_MAX,
    description:
      'Motivo con el que se confirma superar la dosis máxima o un aviso de alergia. Sin él, 409.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(OVERRIDE_REASON_MAX)
  overrideReason?: string;
}

export class DoseAlertDto {
  @ApiProperty({ example: 'DOSE_OVER_MAX' }) code!: string;
  @ApiProperty({ enum: ['BLOCKING', 'INFO'] }) severity!: 'BLOCKING' | 'INFO';
  @ApiProperty() message!: string;
  @ApiProperty() source!: string;
}

export class AnestheticDoseDto {
  @ApiProperty() name!: string;
  @ApiProperty() activeIngredient!: string;
  @ApiProperty() concentrationPct!: number;
  @ApiProperty() carpules!: number;
  @ApiProperty() mg!: number;
  @ApiProperty({ type: Number, nullable: true }) maxMg!: number | null;
  @ApiProperty({ type: Number, nullable: true }) percent!: number | null;
}

export class AnesthesiaDoseSummaryDto {
  @ApiProperty({ example: 'ANESTHESIA_DOSE_V1' }) rulesVersion!: string;
  @ApiProperty({ type: Number, nullable: true }) weightKg!: number | null;
  @ApiProperty({ description: 'mg acumulados de la evolución' })
  totalMg!: number;
  @ApiProperty({ type: [AnestheticDoseDto] })
  byAnesthetic!: AnestheticDoseDto[];
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Suma de las fracciones de cada máximo, en %; null sin peso',
  })
  percent!: number | null;
  @ApiProperty({ enum: ['OK', 'WARNING', 'EXCEEDED', 'NO_WEIGHT'] })
  level!: 'OK' | 'WARNING' | 'EXCEEDED' | 'NO_WEIGHT';
  @ApiProperty({ type: [DoseAlertDto] }) alerts!: DoseAlertDto[];
}

export class AnesthesiaCheckDto {
  @ApiProperty({ type: AnesthesiaDoseSummaryDto })
  summary!: AnesthesiaDoseSummaryDto;
  @ApiProperty({ type: Number, nullable: true }) ageYears!: number | null;
  @ApiProperty({ enum: ['ANAMNESIS', 'ENTERED'], nullable: true })
  weightSource!: 'ANAMNESIS' | 'ENTERED' | null;
  @ApiProperty({ description: 'Menor de 12 años sin peso: hay que anotarlo' })
  weightRequired!: boolean;
}

export class AnesthesiaAdministrationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ format: 'uuid' }) clinicalEntryId!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;
  @ApiProperty({ format: 'uuid' }) anestheticId!: string;
  @ApiProperty() anestheticName!: string;
  @ApiProperty() activeIngredient!: string;
  @ApiProperty() concentrationPct!: number;
  @ApiProperty({ type: String, nullable: true }) vasoconstrictor!:
    string | null;
  @ApiProperty() mlPerCarpule!: number;
  @ApiProperty() maxMgPerKg!: number;
  @ApiProperty() maxAbsoluteMg!: number;
  @ApiProperty() carpules!: number;
  @ApiProperty() doseMg!: number;
  @ApiProperty({ enum: AnesthesiaTechnique, enumName: 'AnesthesiaTechnique' })
  technique!: AnesthesiaTechnique;
  @ApiProperty({ type: String, nullable: true }) site!: string | null;
  @ApiProperty({ type: String, nullable: true }) lot!: string | null;
  @ApiProperty({ format: 'date-time' }) administeredAt!: Date;
  @ApiProperty({ type: Number, nullable: true }) weightKg!: number | null;
  @ApiProperty({ enum: ['ANAMNESIS', 'ENTERED'], nullable: true })
  weightSource!: 'ANAMNESIS' | 'ENTERED' | null;
  @ApiProperty() cumulativeMg!: number;
  @ApiProperty({ type: Number, nullable: true })
  cumulativePercent!: number | null;
  @ApiProperty() safetyRulesVersion!: string;
  @ApiProperty({ type: [DoseAlertDto] }) safetyAlerts!: DoseAlertDto[];
  @ApiProperty({ type: String, nullable: true })
  overrideReason!: string | null;
  @ApiProperty({ format: 'uuid' }) authorId!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
}

export class RecordedAnesthesiaDto extends AnesthesiaAdministrationDto {
  @ApiProperty({ type: AnesthesiaDoseSummaryDto })
  summary!: AnesthesiaDoseSummaryDto;
}

export class EntryAnesthesiaDto {
  @ApiProperty({ type: [AnesthesiaAdministrationDto] })
  records!: AnesthesiaAdministrationDto[];
  @ApiProperty({ type: AnesthesiaDoseSummaryDto })
  summary!: AnesthesiaDoseSummaryDto;
  @ApiProperty({ type: Number, nullable: true }) ageYears!: number | null;
  @ApiProperty() weightRequired!: boolean;
}

export class AnesthesiaConflictDto {
  @ApiProperty({ example: 409 }) statusCode!: number;
  @ApiProperty({ description: 'Mensaje en español con los avisos' })
  message!: string;
  @ApiProperty({ type: AnesthesiaDoseSummaryDto })
  summary!: AnesthesiaDoseSummaryDto;
  @ApiProperty({ type: [DoseAlertDto] }) safetyAlerts!: DoseAlertDto[];
}
