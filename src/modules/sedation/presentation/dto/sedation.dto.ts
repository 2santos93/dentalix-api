import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AsaClass,
  SedationAgentKind,
  SedationDoseUnit,
  SedationGrade,
  SedationLevel,
  SedationRoute,
  SedationVitalsPhase,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const ONE_DECIMAL = { maxDecimalPlaces: 1 };

/**
 * Mensaje de un valor fuera de rango con el rango permitido (QA DX-407):
 * «El N₂O tiene que estar entre 10 y 70 %.», no el genérico en inglés.
 */
function inRange(label: string, min: number, max: number, unit = '') {
  const n = (v: number) => String(v).replace('.', ',');
  return {
    message: `${label} tiene que estar entre ${n(min)} y ${n(max)}${unit ? ` ${unit}` : ''}.`,
  };
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export class SedationAssessmentDto {
  @ApiProperty({ enum: SedationGrade, enumName: 'SedationGrade' })
  @IsEnum(SedationGrade)
  grade!: SedationGrade;

  @ApiPropertyOptional({ enum: AsaClass, enumName: 'AsaClass' })
  @IsOptional()
  @IsEnum(AsaClass)
  asaClass?: AsaClass;

  @ApiProperty({ description: 'Sufijo «E» de la ASA (urgencia)' })
  @IsBoolean()
  asaEmergency!: boolean;

  @ApiPropertyOptional({
    maxLength: 1000,
    description: 'Con ASA III o más: nota de la interconsulta médica',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  highAsaInterconsultation?: string;

  @ApiPropertyOptional({
    maxLength: 1000,
    description: 'Con ASA III o más, sin interconsulta: justificación',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  highAsaJustification?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 72, description: 'Horas' })
  @IsOptional()
  @IsNumber(ONE_DECIMAL)
  @Min(0, inRange('El ayuno de líquidos claros', 0, 72, 'h'))
  @Max(72, inRange('El ayuno de líquidos claros', 0, 72, 'h'))
  fastingClearLiquidsHours?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 72, description: 'Horas' })
  @IsOptional()
  @IsNumber(ONE_DECIMAL)
  @Min(0, inRange('El ayuno de sólidos y leche', 0, 72, 'h'))
  @Max(72, inRange('El ayuno de sólidos y leche', 0, 72, 'h'))
  fastingSolidsHours?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 4 })
  @IsOptional()
  @IsInt()
  @Min(1, inRange('La clase de Mallampati', 1, 4))
  @Max(4, inRange('La clase de Mallampati', 1, 4))
  mallampati?: number;

  @ApiPropertyOptional({
    minimum: 0.1,
    maximum: 399,
    description: 'Peso medido hoy en el sillón (kg)',
  })
  @IsOptional()
  @IsNumber(ONE_DECIMAL)
  @Min(0.1, inRange('El peso', 0.1, 399, 'kg'))
  @Max(399, inRange('El peso', 0.1, 399, 'kg'))
  weightKg?: number;

  @ApiPropertyOptional({ minimum: 30, maximum: 250, description: 'Talla (cm)' })
  @IsOptional()
  @IsNumber(ONE_DECIMAL)
  @Min(30, inRange('La talla', 30, 250, 'cm'))
  @Max(250, inRange('La talla', 30, 250, 'cm'))
  heightCm?: number;

  @ApiPropertyOptional({ maxLength: 120, description: 'Acompañante adulto' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  escortName?: string;

  @ApiPropertyOptional({ maxLength: 60, example: 'Madre' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  escortRelationship?: string;

  @ApiProperty({ description: 'El consentimiento de sedación está firmado' })
  @IsBoolean()
  consentConfirmed!: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Consentimiento firmado del paciente (patient_consents)',
  })
  @IsOptional()
  @IsUUID()
  consentId?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Hora de la valoración; por defecto, ahora',
  })
  @IsOptional()
  @IsDateString()
  assessedAt?: string;
}

export class SedationMarkDto {
  @ApiProperty({ example: 'MONITORS_TESTED' })
  @IsString()
  @MaxLength(40)
  code!: string;

  @ApiProperty()
  @IsBoolean()
  checked!: boolean;
}

export class SedationChecklistDto {
  @ApiProperty({ type: [SedationMarkDto] })
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => SedationMarkDto)
  items!: SedationMarkDto[];

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Hora del checklist; por defecto, ahora. No puede ser anterior a la valoración',
  })
  @IsOptional()
  @IsDateString()
  checkedAt?: string;
}

export class SedationAgentDto {
  @ApiProperty({ enum: SedationAgentKind, enumName: 'SedationAgentKind' })
  @IsEnum(SedationAgentKind)
  kind!: SedationAgentKind;

  @ApiPropertyOptional({ maxLength: 80, description: 'Oral u otro' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  drugName?: string;

  @ApiPropertyOptional({ minimum: 0.01, maximum: 10000 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, inRange('La dosis', 0.01, 10000))
  @Max(10000, inRange('La dosis', 0.01, 10000))
  dose?: number;

  @ApiPropertyOptional({ enum: SedationDoseUnit, enumName: 'SedationDoseUnit' })
  @IsOptional()
  @IsEnum(SedationDoseUnit)
  doseUnit?: SedationDoseUnit;

  @ApiPropertyOptional({
    enum: SedationRoute,
    enumName: 'SedationRoute',
    description: 'N2O: inhalada; oral: por defecto oral',
  })
  @IsOptional()
  @IsEnum(SedationRoute)
  route?: SedationRoute;

  @ApiPropertyOptional({ minimum: 10, maximum: 70, description: 'N2O: %' })
  @IsOptional()
  @IsInt()
  @Min(10, inRange('El N₂O', 10, 70, '%'))
  @Max(70, inRange('El N₂O', 10, 70, '%'))
  n2oPercent?: number;

  @ApiPropertyOptional({
    minimum: 0.5,
    maximum: 15,
    description: 'N2O: flujo total en l/min',
  })
  @IsOptional()
  @IsNumber(ONE_DECIMAL)
  @Min(0.5, inRange('El flujo total', 0.5, 15, 'l/min'))
  @Max(15, inRange('El flujo total', 0.5, 15, 'l/min'))
  flowLpm?: number;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Hora de la administración; por defecto, ahora',
  })
  @IsOptional()
  @IsDateString()
  administeredAt?: string;
}

export class SedationVitalsValuesDto {
  @ApiPropertyOptional({ minimum: 50, maximum: 100, description: 'SpO2 (%)' })
  @IsOptional()
  @IsInt()
  @Min(50, inRange('La SpO₂', 50, 100, '%'))
  @Max(100, inRange('La SpO₂', 50, 100, '%'))
  spo2?: number;

  @ApiPropertyOptional({ minimum: 20, maximum: 250, description: 'lpm' })
  @IsOptional()
  @IsInt()
  @Min(20, inRange('La FC', 20, 250, 'lpm'))
  @Max(250, inRange('La FC', 20, 250, 'lpm'))
  heartRate?: number;

  @ApiPropertyOptional({ minimum: 40, maximum: 300, description: 'mmHg' })
  @IsOptional()
  @IsInt()
  @Min(40, inRange('La TA sistólica', 40, 300, 'mmHg'))
  @Max(300, inRange('La TA sistólica', 40, 300, 'mmHg'))
  systolic?: number;

  @ApiPropertyOptional({ minimum: 20, maximum: 200, description: 'mmHg' })
  @IsOptional()
  @IsInt()
  @Min(20, inRange('La TA diastólica', 20, 200, 'mmHg'))
  @Max(200, inRange('La TA diastólica', 20, 200, 'mmHg'))
  diastolic?: number;

  @ApiPropertyOptional({ minimum: 2, maximum: 80, description: 'rpm' })
  @IsOptional()
  @IsInt()
  @Min(2, inRange('La FR', 2, 80, 'rpm'))
  @Max(80, inRange('La FR', 2, 80, 'rpm'))
  respiratoryRate?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 150,
    description: 'CO2 espirado (mmHg), opcional',
  })
  @IsOptional()
  @IsInt()
  @Min(0, inRange('El CO₂ espirado', 0, 150, 'mmHg'))
  @Max(150, inRange('El CO₂ espirado', 0, 150, 'mmHg'))
  etco2?: number;

  @ApiPropertyOptional({ enum: SedationLevel, enumName: 'SedationLevel' })
  @IsOptional()
  @IsEnum(SedationLevel)
  sedationLevel?: SedationLevel;
}

export class SedationVitalsDto extends SedationVitalsValuesDto {
  @ApiProperty({
    enum: ['BASELINE', 'INTRA'],
    description: 'La toma al alta va con el egreso',
  })
  @IsIn(['BASELINE', 'INTRA'])
  phase!: 'BASELINE' | 'INTRA';

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Hora de la toma; por defecto, ahora',
  })
  @IsOptional()
  @IsDateString()
  takenAt?: string;
}

export class SedationCriterionMarkDto {
  @ApiProperty({ example: 'AIRWAY_PATENT' })
  @IsString()
  @MaxLength(40)
  code!: string;

  @ApiProperty()
  @IsBoolean()
  met!: boolean;
}

export class SedationDischargeDto {
  @ApiProperty({ type: [SedationCriterionMarkDto] })
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => SedationCriterionMarkDto)
  criteria!: SedationCriterionMarkDto[];

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 10,
    description: 'Aldrete modificado; ≥ 9 sustituye a los criterios',
  })
  @IsOptional()
  @IsInt()
  @Min(0, inRange('El Aldrete modificado', 0, 10))
  @Max(10, inRange('El Aldrete modificado', 0, 10))
  aldreteScore?: number;

  @ApiProperty({
    type: SedationVitalsValuesDto,
    description: 'Constantes al alta',
  })
  @ValidateNested()
  @Type(() => SedationVitalsValuesDto)
  vitals!: SedationVitalsValuesDto;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Hora del egreso; por defecto, ahora',
  })
  @IsOptional()
  @IsDateString()
  dischargedAt?: string;

  @ApiProperty({ maxLength: 120, description: 'A quién se entrega' })
  @IsString()
  @MaxLength(120)
  handedOverToName!: string;

  @ApiProperty({ maxLength: 60, example: 'Madre' })
  @IsString()
  @MaxLength(60)
  handedOverToRelationship!: string;

  @ApiProperty({ description: 'Indicaciones entregadas al acompañante' })
  @IsBoolean()
  instructionsDelivered!: boolean;

  @ApiProperty({
    format: 'uuid',
    description: 'Quien monitorizó (miembro clínico de la clínica)',
  })
  @IsUUID()
  monitorId!: string;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Sedación moderada con el operador como monitor: justificación (≥ 10 caracteres)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  sameMonitorJustification?: string;
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

export class SedationChecklistItemDefDto {
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiProperty() required!: boolean;
}

export class SedationDischargeCriterionDefDto {
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
}

const ASSESSMENT_FIELDS = [
  'ASA',
  'FASTING',
  'MALLAMPATI',
  'WEIGHT',
  'HEIGHT',
  'ESCORT',
  'CONSENT',
];
const VITAL_FIELDS = [
  'SPO2',
  'HEART_RATE',
  'BLOOD_PRESSURE',
  'RESPIRATORY_RATE',
  'ETCO2',
  'SEDATION_LEVEL',
];

export class SedationTemplateDto {
  @ApiProperty({ example: 'SEDATION_PLATFORM_V1' }) version!: string;
  @ApiProperty({
    enum: ['PLATFORM', 'CLINIC'],
    description:
      'Hoy siempre PLATFORM; la plantilla por clínica llega en DX-409',
  })
  source!: 'PLATFORM' | 'CLINIC';
  @ApiProperty({ example: 5 }) vitalsIntervalMinutes!: number;
  @ApiProperty({ enum: ASSESSMENT_FIELDS, isArray: true })
  requiredAssessment!: string[];
  @ApiProperty({ type: [SedationChecklistItemDefDto] })
  checklist!: SedationChecklistItemDefDto[];
  @ApiProperty({ enum: VITAL_FIELDS, isArray: true })
  requiredVitals!: string[];
  @ApiProperty({ type: [SedationDischargeCriterionDefDto] })
  dischargeCriteria!: SedationDischargeCriterionDefDto[];
  @ApiProperty({ example: 9 }) aldreteMinimum!: number;
}

export class SedationActorDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
}

export class SedationChecklistItemDto {
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiProperty() checked!: boolean;
}

export class SedationChecklistRowDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: [SedationChecklistItemDto] })
  items!: SedationChecklistItemDto[];
  @ApiProperty({ type: SedationActorDto }) author!: SedationActorDto;
  @ApiProperty({
    format: 'date-time',
    description:
      'Hora del checklist (la anotada; por defecto, la del registro)',
  })
  checkedAt!: Date;
  @ApiProperty({ format: 'date-time', description: 'Hora del servidor' })
  createdAt!: Date;
}

export class SedationAgentRowDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: SedationAgentKind, enumName: 'SedationAgentKind' })
  kind!: SedationAgentKind;
  @ApiProperty({ type: String, nullable: true }) drugName!: string | null;
  @ApiProperty({ type: Number, nullable: true }) dose!: number | null;
  @ApiProperty({
    enum: SedationDoseUnit,
    enumName: 'SedationDoseUnit',
    nullable: true,
  })
  doseUnit!: SedationDoseUnit | null;
  @ApiProperty({ enum: SedationRoute, enumName: 'SedationRoute' })
  route!: SedationRoute;
  @ApiProperty({ type: Number, nullable: true }) n2oPercent!: number | null;
  @ApiProperty({ type: Number, nullable: true }) flowLpm!: number | null;
  @ApiProperty({ format: 'date-time' }) administeredAt!: Date;
  @ApiProperty({ type: SedationActorDto }) author!: SedationActorDto;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
}

export class SedationVitalsRowDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: SedationVitalsPhase, enumName: 'SedationVitalsPhase' })
  phase!: SedationVitalsPhase;
  @ApiProperty({ format: 'date-time' }) takenAt!: Date;
  @ApiProperty({ type: Number, nullable: true }) spo2!: number | null;
  @ApiProperty({ type: Number, nullable: true }) heartRate!: number | null;
  @ApiProperty({ type: Number, nullable: true }) systolic!: number | null;
  @ApiProperty({ type: Number, nullable: true }) diastolic!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  respiratoryRate!: number | null;
  @ApiProperty({ type: Number, nullable: true }) etco2!: number | null;
  @ApiProperty({
    enum: SedationLevel,
    enumName: 'SedationLevel',
    nullable: true,
  })
  sedationLevel!: SedationLevel | null;
  @ApiProperty({ type: SedationActorDto }) author!: SedationActorDto;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
}

export class SedationDischargeCriterionDto {
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiProperty() met!: boolean;
}

export class SedationDischargeRowDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: [SedationDischargeCriterionDto] })
  criteria!: SedationDischargeCriterionDto[];
  @ApiProperty({ type: Number, nullable: true }) aldreteScore!: number | null;
  @ApiProperty({ format: 'uuid', description: 'Toma de constantes al alta' })
  vitalsId!: string;
  @ApiProperty({ format: 'date-time' }) dischargedAt!: Date;
  @ApiProperty() handedOverToName!: string;
  @ApiProperty() handedOverToRelationship!: string;
  @ApiProperty() instructionsDelivered!: boolean;
  @ApiProperty({ type: SedationActorDto, description: 'Firma el egreso' })
  operator!: SedationActorDto;
  @ApiProperty({ type: SedationActorDto }) monitor!: SedationActorDto;
  @ApiProperty({ type: String, nullable: true })
  sameMonitorJustification!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
}

export class SedationVitalsWatchDto {
  @ApiProperty() intervalMinutes!: number;
  @ApiProperty({
    description: 'Sedación en curso (checklist, inicio y sin egreso)',
  })
  active!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastTakenAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  nextDueAt!: Date | null;
  @ApiProperty({ description: 'Se pasó el intervalo sin toma' })
  overdue!: boolean;
  @ApiProperty() overdueMinutes!: number;
  @ApiProperty({
    description:
      'Intervalos vencidos sin toma entre el inicio y la última toma: en cada hueco, ⌈hueco / intervalo⌉ − 1 (20 min con intervalo de 5 → 3)',
  })
  missedIntervals!: number;
}

export class SedationSheetDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ format: 'uuid' }) clinicalEntryId!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;
  @ApiProperty() templateVersion!: string;
  @ApiProperty() rulesVersion!: string;
  @ApiProperty() vitalsIntervalMinutes!: number;
  @ApiProperty({ enum: ['ASSESSED', 'CHECKED', 'IN_PROGRESS', 'DISCHARGED'] })
  status!: 'ASSESSED' | 'CHECKED' | 'IN_PROGRESS' | 'DISCHARGED';
  @ApiProperty({ enum: SedationGrade, enumName: 'SedationGrade' })
  grade!: SedationGrade;
  @ApiProperty({ enum: AsaClass, enumName: 'AsaClass', nullable: true })
  asaClass!: AsaClass | null;
  @ApiProperty() asaEmergency!: boolean;
  @ApiProperty({ type: String, nullable: true })
  highAsaInterconsultation!: string | null;
  @ApiProperty({ type: String, nullable: true })
  highAsaJustification!: string | null;
  @ApiProperty({ type: Number, nullable: true })
  fastingClearLiquidsHours!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  fastingSolidsHours!: number | null;
  @ApiProperty({ type: Number, nullable: true }) mallampati!: number | null;
  @ApiProperty({ type: Number, nullable: true }) weightKg!: number | null;
  @ApiProperty({ type: Number, nullable: true }) heightCm!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Calculado' })
  bmi!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Naloxona 0,1 mg/kg, máx. 2 mg',
  })
  naloxoneMg!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Flumazenil 0,01 mg/kg, máx. 0,2 mg',
  })
  flumazenilMg!: number | null;
  @ApiProperty({ type: String, nullable: true }) escortName!: string | null;
  @ApiProperty({ type: String, nullable: true })
  escortRelationship!: string | null;
  @ApiProperty() consentConfirmed!: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  consentId!: string | null;
  @ApiProperty({ type: SedationActorDto }) author!: SedationActorDto;
  @ApiProperty({
    format: 'date-time',
    description:
      'Hora de la valoración (la anotada; por defecto, la del registro)',
  })
  assessedAt!: Date;
  @ApiProperty({ format: 'date-time', description: 'Hora del servidor' })
  createdAt!: Date;
  @ApiProperty({ type: SedationChecklistRowDto, nullable: true })
  checklist!: SedationChecklistRowDto | null;
  @ApiProperty({ type: [SedationAgentRowDto] }) agents!: SedationAgentRowDto[];
  @ApiProperty({ type: [SedationVitalsRowDto] })
  vitals!: SedationVitalsRowDto[];
  @ApiProperty({ type: SedationDischargeRowDto, nullable: true })
  discharge!: SedationDischargeRowDto | null;
  @ApiProperty({ type: SedationVitalsWatchDto }) watch!: SedationVitalsWatchDto;
}

export class EntrySedationDto {
  @ApiProperty({ type: SedationTemplateDto }) template!: SedationTemplateDto;
  @ApiProperty({ type: SedationSheetDto, nullable: true })
  sheet!: SedationSheetDto | null;
}

export class SedationProblemDto {
  @ApiProperty({ example: 'MALLAMPATI' }) code!: string;
  @ApiProperty() message!: string;
}

export class SedationProblemsDto {
  @ApiProperty({ example: 400 }) statusCode!: number;
  @ApiProperty({ description: 'Lo que falta, en español' }) message!: string;
  @ApiProperty({ type: [SedationProblemDto] }) problems!: SedationProblemDto[];
}
