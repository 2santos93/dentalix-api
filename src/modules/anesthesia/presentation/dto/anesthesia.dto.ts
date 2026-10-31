import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { AnesthesiaTechnique } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
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
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 4.4,
    description:
      'DX-420: mg/kg en menores de 12 años (AAPD); null = el de adulto',
  })
  pediatricMaxMgPerKg!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 4,
    description:
      'DX-420: edad mínima en años (AAPD: articaína 4, bupivacaína 12); null = sin mínimo',
  })
  minAgeYears!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0.018,
    description:
      'DX-420: mg de epinefrina por carpule (ml × 1000 / dilución; 1:100.000 → 0,01 mg/ml); 0 sin epinefrina; null = no se sabe',
  })
  epinephrineMgPerCarpule!: number | null;
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

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0.1,
    maximum: 20,
    description: 'DX-420: mg/kg en menores de 12 años; null = el de adulto',
  })
  @IsOptional()
  @IsNumber(NUMBER)
  @Min(0.1)
  @Max(20)
  pediatricMaxMgPerKg?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 18,
    description: 'DX-420: edad mínima en años; null = sin mínimo',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(18)
  minAgeYears?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 0.2,
    description:
      'DX-420: mg de epinefrina por carpule. Sin él, se deduce de la dilución del vasoconstrictor y del volumen (1:100.000 × 1,8 ml = 0,018 mg)',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(0.2)
  epinephrineMgPerCarpule?: number | null;
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

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Hora de la administración; por defecto, ahora. No puede ser futura. Decide la ventana de 24 h del acumulado del paciente, que la contiene (DX-418): manda la misma al previsualizar y al guardar.',
  })
  @IsOptional()
  @IsDateString()
  administeredAt?: string;
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
    minLength: OVERRIDE_REASON_MIN,
    maxLength: OVERRIDE_REASON_MAX,
    description:
      'Motivo con el que se confirma superar la dosis máxima, el tope de epinefrina, la edad mínima del anestésico (DX-420) o un aviso de alergia. Sin él, 409.',
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
  @ApiProperty({
    example: 4.4,
    description:
      'DX-420: mg/kg usado (pediátrico en menores de 12 años si el catálogo lo tiene)',
  })
  maxMgPerKg!: number;
  @ApiProperty({ description: 'DX-420: fuente del máximo, para enseñarla' })
  maxSource!: string;
}

export class DoseAdjustmentDto {
  @ApiProperty({
    description: 'DX-420: menor de 12 años (máximo pediátrico del catálogo)',
  })
  pediatric!: boolean;
  @ApiProperty({ description: 'Menor de 6 meses: −30 %' }) infant!: boolean;
  @ApiProperty({
    description: 'Hoja de sedación en esta evolución o en las 24 h: −30 %',
  })
  sedation!: boolean;
  @ApiProperty({
    example: 0.7,
    description:
      'Multiplicador del máximo (1 = sin reducción; 0,49 con las dos)',
  })
  factor!: number;
  @ApiProperty({ type: Number, nullable: true }) ageYears!: number | null;
}

export class EpinephrineSummaryDto {
  @ApiProperty({
    example: 0.054,
    description: 'mg de epinefrina del paciente en la misma ventana de 24 h',
  })
  totalMg!: number;
  @ApiProperty({
    example: 0.04,
    description:
      'Tope por cita: 0,2 mg; 0,04 mg con cardiopatía en la anamnesis',
  })
  maxMg!: number;
  @ApiProperty() percent!: number;
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: 'Cardiopatía en la anamnesis; null sin anamnesis',
  })
  cardiac!: boolean | null;
  @ApiProperty({ enum: ['OK', 'WARNING', 'EXCEEDED'] })
  level!: 'OK' | 'WARNING' | 'EXCEEDED';
}

export class DoseRemainingDto {
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'mg que quedan de este anestésico' }) mg!: number;
  @ApiProperty({ description: 'En cuartos de carpule, hacia abajo' })
  carpules!: number;
  @ApiProperty({ example: 1.8 }) mlPerCarpule!: number;
  @ApiProperty({ enum: ['DOSE', 'EPINEPHRINE'] })
  limitedBy!: 'DOSE' | 'EPINEPHRINE';
  @ApiProperty({ description: 'mg de epinefrina que quedan hasta el tope' })
  epinephrineMg!: number;
}

export class AnesthesiaDoseSummaryDto {
  @ApiProperty({ example: 'ANESTHESIA_DOSE_V3' }) rulesVersion!: string;
  @ApiProperty({ type: Number, nullable: true }) weightKg!: number | null;
  @ApiProperty({
    description:
      'mg acumulados del PACIENTE en la ventana de 24 h (DX-418): todas sus evoluciones, sedes y profesionales de la clínica',
  })
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
  @ApiProperty({ type: DoseAdjustmentDto })
  adjustment!: DoseAdjustmentDto;
  @ApiProperty({ type: EpinephrineSummaryDto })
  epinephrine!: EpinephrineSummaryDto;
  @ApiProperty({
    type: DoseRemainingDto,
    nullable: true,
    description:
      'DX-420: «quedan X mg ≈ Y carpules» del anestésico previsualizado (lo que se agote antes: dosis o epinefrina); null sin dosis nueva o sin peso',
  })
  remaining!: DoseRemainingDto | null;
}

export class AnesthesiaDoseWindowPartDto {
  @ApiProperty({ format: 'uuid' }) clinicalEntryId!: string;
  @ApiProperty({ description: 'Es la evolución consultada' })
  current!: boolean;
  @ApiProperty({ format: 'uuid' }) authorId!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Profesional que la registró',
  })
  authorName!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Sede (cuentan también las de otra sede de la clínica)',
  })
  locationName!: string | null;
  @ApiProperty({ format: 'date-time' }) firstAdministeredAt!: Date;
  @ApiProperty({ format: 'date-time' }) lastAdministeredAt!: Date;
  @ApiProperty() carpules!: number;
  @ApiProperty() mg!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Parte del máximo que aporta, en % (redondeada: las partes pueden no sumar el total); null sin peso',
  })
  percent!: number | null;
}

export class AnesthesiaDoseWindowDto {
  @ApiProperty({
    example: 24,
    description:
      'DX-418: ventana MÓVIL de 24 h, no el día civil de la sede: las dosis máximas de anestésico local son por sesión / 24 h, y con el día civil 3 carpules a las 23:30 y 3 a las 00:30 empezarían de cero. Es la ventana de 24 h que contiene la administración con más acumulado: «ahora», las últimas 24 h; anotada tarde, puede ser la que acaba en una dosis posterior ya registrada. Nunca suma dosis a más de 24 h entre sí.',
  })
  hours!: number;
  @ApiProperty({ format: 'date-time', description: 'Inicio (incluido)' })
  from!: Date;
  @ApiProperty({ format: 'date-time', description: 'Fin (incluido)' })
  to!: Date;
  @ApiProperty({
    type: [AnesthesiaDoseWindowPartDto],
    description:
      'Lo ya registrado, por evolución y profesional, en orden de administración',
  })
  parts!: AnesthesiaDoseWindowPartDto[];
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'mg de la dosis previsualizada (sin guardar); null si no hay',
  })
  pendingMg!: number | null;
}

export class AnesthesiaCheckDto {
  @ApiProperty({
    type: AnesthesiaDoseSummaryDto,
    description:
      'Acumulado del paciente en la ventana de 24 h CON la dosis previsualizada',
  })
  summary!: AnesthesiaDoseSummaryDto;
  @ApiProperty({ type: Number, nullable: true }) ageYears!: number | null;
  @ApiProperty({ enum: ['ANAMNESIS', 'ENTERED'], nullable: true })
  weightSource!: 'ANAMNESIS' | 'ENTERED' | null;
  @ApiProperty({ description: 'Menor de 12 años sin peso: hay que anotarlo' })
  weightRequired!: boolean;
  @ApiProperty({ type: AnesthesiaDoseWindowDto })
  window!: AnesthesiaDoseWindowDto;
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
  @ApiProperty({ type: Number, nullable: true })
  pediatricMaxMgPerKg!: number | null;
  @ApiProperty({ type: Number, nullable: true }) minAgeYears!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  epinephrineMgPerCarpule!: number | null;
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
  @ApiProperty({
    description:
      'mg acumulados CON este registro: de la evolución con ANESTHESIA_DOSE_V1; del paciente en 24 h con ANESTHESIA_DOSE_V2 (DX-418)',
  })
  cumulativeMg!: number;
  @ApiProperty({ type: Number, nullable: true })
  cumulativePercent!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'DX-420: mg de epinefrina de esta dosis; null antes de V3',
  })
  epinephrineMg!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'DX-420: epinefrina acumulada del paciente en la ventana CON este registro; null antes de V3',
  })
  cumulativeEpinephrineMg!: number | null;
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
  @ApiProperty({
    type: [AnesthesiaAdministrationDto],
    description: 'Lo registrado en esta evolución',
  })
  records!: AnesthesiaAdministrationDto[];
  @ApiProperty({
    type: AnesthesiaDoseSummaryDto,
    description: 'Acumulado del paciente en las últimas 24 h (DX-418)',
  })
  summary!: AnesthesiaDoseSummaryDto;
  @ApiProperty({ type: Number, nullable: true }) ageYears!: number | null;
  @ApiProperty() weightRequired!: boolean;
  @ApiProperty({ type: AnesthesiaDoseWindowDto })
  window!: AnesthesiaDoseWindowDto;
}

export class AnesthesiaConflictDto {
  @ApiProperty({ example: 409 }) statusCode!: number;
  @ApiProperty({ description: 'Mensaje en español con los avisos' })
  message!: string;
  @ApiProperty({ type: AnesthesiaDoseSummaryDto })
  summary!: AnesthesiaDoseSummaryDto;
  @ApiProperty({ type: [DoseAlertDto] }) safetyAlerts!: DoseAlertDto[];
}
