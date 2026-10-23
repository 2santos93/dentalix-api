import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  ANSWER_LIMITS,
  YES_NO_UNKNOWN,
  type YesNoUnknown,
} from '../../domain/anamnesis-questionnaire';
import type {
  AllergySeverity,
  AllergyType,
} from '../../../medical-history/domain/entities/medical-history.entity';

const ALLERGY_TYPES: AllergyType[] = [
  'MEDICAMENTO',
  'MATERIAL',
  'ALIMENTO',
  'AMBIENTAL',
];
const ALLERGY_SEVERITIES: AllergySeverity[] = [
  'LEVE',
  'MODERADA',
  'ANAFILAXIA',
];

const answerProperty = {
  enum: YES_NO_UNKNOWN,
  enumName: 'AnamnesisAnswer',
  description: 'Sí / No / No sé',
};
const ANSWER_MESSAGE = 'Elija Sí, No o No sé.';
const TEXT_MESSAGE = `Como mucho ${ANSWER_LIMITS.text} caracteres.`;
const LIST_MESSAGE = `Como mucho ${ANSWER_LIMITS.listItems} elementos.`;

// Formas del cuestionario público (DX-099). Validadas aquí (forma y topes,
// con `whitelist` nada desconocido llega a `answers`); las reglas que cruzan
// campos (un «Sí» con lista exige un elemento, todas las condiciones) viven
// en `answersValidationErrors`.

export class AllergyAnswerDto {
  @ApiProperty({ maxLength: ANSWER_LIMITS.text })
  @IsString()
  @MaxLength(ANSWER_LIMITS.text, { message: TEXT_MESSAGE })
  alergeno!: string;

  @ApiProperty({ enum: ALLERGY_TYPES, enumName: 'AnamnesisAllergyType' })
  @IsIn(ALLERGY_TYPES, { message: 'Elija el tipo de alergia.' })
  tipo!: AllergyType;

  @ApiPropertyOptional({ maxLength: ANSWER_LIMITS.text })
  @IsOptional()
  @IsString()
  @MaxLength(ANSWER_LIMITS.text, { message: TEXT_MESSAGE })
  reaccion?: string;

  @ApiProperty({
    enum: ALLERGY_SEVERITIES,
    enumName: 'AnamnesisAllergySeverity',
  })
  @IsIn(ALLERGY_SEVERITIES, { message: 'Elija cómo fue la reacción.' })
  severidad!: AllergySeverity;
}

export class MedicationAnswerDto {
  @ApiProperty({ maxLength: ANSWER_LIMITS.text })
  @IsString()
  @MaxLength(ANSWER_LIMITS.text, { message: TEXT_MESSAGE })
  nombre!: string;

  @ApiPropertyOptional({ maxLength: ANSWER_LIMITS.text })
  @IsOptional()
  @IsString()
  @MaxLength(ANSWER_LIMITS.text, { message: TEXT_MESSAGE })
  dosis?: string;

  @ApiPropertyOptional({ maxLength: ANSWER_LIMITS.text })
  @IsOptional()
  @IsString()
  @MaxLength(ANSWER_LIMITS.text, { message: TEXT_MESSAGE })
  frecuencia?: string;
}

export class SurgeryAnswerDto {
  @ApiProperty({ maxLength: ANSWER_LIMITS.text })
  @IsString()
  @MaxLength(ANSWER_LIMITS.text, { message: TEXT_MESSAGE })
  descripcion!: string;

  @ApiPropertyOptional({ maxLength: 40, description: 'Año o fecha aproximada' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  fecha?: string;
}

export class AllergiesAnswerDto {
  @ApiProperty(answerProperty)
  @IsIn(YES_NO_UNKNOWN, { message: ANSWER_MESSAGE })
  answer!: YesNoUnknown;

  @ApiPropertyOptional({ type: [AllergyAnswerDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ANSWER_LIMITS.listItems, { message: LIST_MESSAGE })
  @ValidateNested({ each: true })
  @Type(() => AllergyAnswerDto)
  items?: AllergyAnswerDto[];
}

export class MedicationsAnswerDto {
  @ApiProperty(answerProperty)
  @IsIn(YES_NO_UNKNOWN, { message: ANSWER_MESSAGE })
  answer!: YesNoUnknown;

  @ApiPropertyOptional({ type: [MedicationAnswerDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ANSWER_LIMITS.listItems, { message: LIST_MESSAGE })
  @ValidateNested({ each: true })
  @Type(() => MedicationAnswerDto)
  items?: MedicationAnswerDto[];
}

export class SurgeriesAnswerDto {
  @ApiProperty(answerProperty)
  @IsIn(YES_NO_UNKNOWN, { message: ANSWER_MESSAGE })
  answer!: YesNoUnknown;

  @ApiPropertyOptional({ type: [SurgeryAnswerDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ANSWER_LIMITS.listItems, { message: LIST_MESSAGE })
  @ValidateNested({ each: true })
  @Type(() => SurgeryAnswerDto)
  items?: SurgeryAnswerDto[];
}

export class ConditionAnswerDto {
  @ApiProperty({ example: 'DIABETES' })
  @IsString()
  @MaxLength(40)
  codigo!: string;

  @ApiProperty(answerProperty)
  @IsIn(YES_NO_UNKNOWN, { message: ANSWER_MESSAGE })
  answer!: YesNoUnknown;

  @ApiPropertyOptional({ maxLength: ANSWER_LIMITS.note })
  @IsOptional()
  @IsString()
  @MaxLength(ANSWER_LIMITS.note, {
    message: `Como mucho ${ANSWER_LIMITS.note} caracteres.`,
  })
  nota?: string;
}

export class AnticoagulantsAnswerDto {
  @ApiProperty(answerProperty)
  @IsIn(YES_NO_UNKNOWN, { message: ANSWER_MESSAGE })
  answer!: YesNoUnknown;

  @ApiPropertyOptional({ maxLength: ANSWER_LIMITS.text, description: '¿Cuál?' })
  @IsOptional()
  @IsString()
  @MaxLength(ANSWER_LIMITS.text, { message: TEXT_MESSAGE })
  detail?: string;
}

export class SmokingAnswerDto {
  @ApiProperty(answerProperty)
  @IsIn(YES_NO_UNKNOWN, { message: ANSWER_MESSAGE })
  answer!: YesNoUnknown;

  @ApiPropertyOptional({ minimum: 0, maximum: ANSWER_LIMITS.perDay })
  @IsOptional()
  @IsInt({ message: 'Escriba un número entero de cigarrillos.' })
  @Min(0)
  @Max(ANSWER_LIMITS.perDay)
  porDia?: number;
}

export class AlcoholAnswerDto {
  @ApiProperty(answerProperty)
  @IsIn(YES_NO_UNKNOWN, { message: ANSWER_MESSAGE })
  answer!: YesNoUnknown;

  @ApiPropertyOptional({ maxLength: ANSWER_LIMITS.text })
  @IsOptional()
  @IsString()
  @MaxLength(ANSWER_LIMITS.text, { message: TEXT_MESSAGE })
  frecuencia?: string;
}

export class SimpleAnswerDto {
  @ApiProperty(answerProperty)
  @IsIn(YES_NO_UNKNOWN, { message: ANSWER_MESSAGE })
  answer!: YesNoUnknown;
}

export class HabitsAnswerDto {
  @ApiProperty({ type: SmokingAnswerDto })
  @ValidateNested()
  @Type(() => SmokingAnswerDto)
  tabaquismo!: SmokingAnswerDto;

  @ApiProperty({ type: AlcoholAnswerDto })
  @ValidateNested()
  @Type(() => AlcoholAnswerDto)
  alcohol!: AlcoholAnswerDto;

  @ApiProperty({ type: SimpleAnswerDto })
  @ValidateNested()
  @Type(() => SimpleAnswerDto)
  bruxismo!: SimpleAnswerDto;
}

export class PregnancyAnswerDto {
  @ApiProperty(answerProperty)
  @IsIn(YES_NO_UNKNOWN, { message: ANSWER_MESSAGE })
  answer!: YesNoUnknown;

  @ApiPropertyOptional({ minimum: 1, maximum: ANSWER_LIMITS.weeks })
  @IsOptional()
  @IsInt({ message: 'Escriba las semanas con un número entero.' })
  @Min(1, { message: 'Las semanas van de 1 a 45.' })
  @Max(ANSWER_LIMITS.weeks, { message: 'Las semanas van de 1 a 45.' })
  semanas?: number;
}

/** Las respuestas completas del cuestionario. */
export class AnamnesisAnswersDto {
  @ApiProperty({ type: AllergiesAnswerDto })
  @ValidateNested()
  @Type(() => AllergiesAnswerDto)
  allergies!: AllergiesAnswerDto;

  @ApiProperty({ type: [ConditionAnswerDto] })
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => ConditionAnswerDto)
  conditions!: ConditionAnswerDto[];

  @ApiProperty({ type: MedicationsAnswerDto })
  @ValidateNested()
  @Type(() => MedicationsAnswerDto)
  medications!: MedicationsAnswerDto;

  @ApiProperty({ type: AnticoagulantsAnswerDto })
  @ValidateNested()
  @Type(() => AnticoagulantsAnswerDto)
  anticoagulants!: AnticoagulantsAnswerDto;

  @ApiProperty({ type: HabitsAnswerDto })
  @ValidateNested()
  @Type(() => HabitsAnswerDto)
  habits!: HabitsAnswerDto;

  @ApiProperty({ type: PregnancyAnswerDto })
  @ValidateNested()
  @Type(() => PregnancyAnswerDto)
  pregnancy!: PregnancyAnswerDto;

  @ApiProperty({ type: SurgeriesAnswerDto })
  @ValidateNested()
  @Type(() => SurgeriesAnswerDto)
  surgeries!: SurgeriesAnswerDto;
}

export class PublicConsentDecisionDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Versión de la política que se le mostró',
  })
  @IsUUID()
  policyVersionId!: string;

  @ApiProperty({
    description: 'true = autoriza el tratamiento de sus datos de salud',
  })
  @IsBoolean()
  granted!: boolean;
}

export class SubmitPublicAnamnesisDto {
  @ApiProperty({ type: AnamnesisAnswersDto })
  @ValidateNested()
  @Type(() => AnamnesisAnswersDto)
  answers!: AnamnesisAnswersDto;

  @ApiProperty({
    description: 'Casilla «Declaro que la información es verdadera»',
  })
  @IsBoolean()
  declarationAccepted!: boolean;

  @ApiPropertyOptional({
    type: PublicConsentDecisionDto,
    description:
      'Solo si `consent.required`: la autorización SENSITIVE_HEALTH (DX-037) con la versión de política mostrada.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PublicConsentDecisionDto)
  consent?: PublicConsentDecisionDto;
}
