import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  AllergySeverity,
  AllergyType,
  ConditionStatus,
} from '../../domain/entities/medical-history.entity';

/**
 * Shared building blocks of the anamnesis, for BOTH the request
 * (`SaveMedicalHistoryDto`) and the response (`MedicalHistoryDto`).
 *
 * They exist so the OpenAPI document describes these structures instead of
 * publishing them as bare objects: with `type: Object` / `type: [Object]`,
 * `openapi-typescript` emits `Record<string, never>`, which is useless for
 * typing a client (the web app had to hand-write the whole shape).
 *
 * `Allergy`/`Condition`/`Medication` and the habits (tri-state) are the
 * VALIDATED input classes (they carry class-validator decorators and are
 * `@ValidateNested`-ed by the save DTO). The rest are DOCUMENTATION-ONLY: the backend still accepts those
 * sections as free JSON, so adding validators here would tighten the contract
 * — a separate decision from documenting it.
 */

const ALLERGY_TYPES = [
  'MEDICAMENTO',
  'MATERIAL',
  'ALIMENTO',
  'AMBIENTAL',
] as const;
const ALLERGY_SEVERITIES = ['LEVE', 'MODERADA', 'ANAFILAXIA'] as const;
const CONDITION_STATUSES = ['SI', 'NO', 'DESCONOCE'] as const;

export class AllergyDto {
  @ApiProperty({ example: 'Penicilina' })
  @IsString()
  alergeno!: string;

  @ApiProperty({ enum: ALLERGY_TYPES })
  @IsEnum(ALLERGY_TYPES)
  tipo!: AllergyType;

  @ApiPropertyOptional({ example: 'Edema' })
  @IsOptional()
  @IsString()
  reaccion?: string;

  @ApiProperty({ enum: ALLERGY_SEVERITIES })
  @IsEnum(ALLERGY_SEVERITIES)
  severidad!: AllergySeverity;

  @ApiProperty({
    description: 'Marca de alerta clínica; alimenta safetyFlags.',
  })
  @IsBoolean()
  esAlerta!: boolean;
}

export class ConditionDto {
  @ApiProperty({ example: 'HIPERTENSION' })
  @IsString()
  codigo!: string;

  @ApiProperty({ example: 'Hipertensión' })
  @IsString()
  etiqueta!: string;

  @ApiProperty({
    enum: CONDITION_STATUSES,
    description:
      'SI = la tiene, NO = no la tiene (respuesta explícita), DESCONOCE = el paciente no lo sabe. «Sin responder» no es un estado: la condición se omite de la lista.',
  })
  @IsEnum(CONDITION_STATUSES)
  estado!: ConditionStatus;

  @ApiProperty()
  @IsBoolean()
  esAlerta!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nota?: string;
}

export class MedicationDto {
  @ApiProperty({ example: 'Losartán' })
  @IsString()
  nombre!: string;

  @ApiPropertyOptional({ example: '50mg' })
  @IsOptional()
  @IsString()
  dosis?: string;

  @ApiPropertyOptional({ example: 'Cada 12 h' })
  @IsOptional()
  @IsString()
  frecuencia?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  motivo?: string;

  @ApiProperty()
  @IsBoolean()
  esAlerta!: boolean;
}

/* ── Hábitos: tri-estado y VALIDADOS ─────────────────────────────────────── */

const ANSWER_DESCRIPTION =
  'SI / NO / DESCONOCE («No sabe»). Ausente = «Sin responder» (nunca se lee como «No»).';

/**
 * Un cliente anterior manda booleanos (`true` = Sí, `false` = No): se
 * traducen ANTES de validar para que una pestaña abierta durante un despliegue
 * no pierda lo que se escribió. Lo demás se valida como tri-estado.
 */
const legacyAnswer = ({ value }: { value: unknown }): unknown =>
  value === true ? 'SI' : value === false ? 'NO' : value;

/**
 * Tabaquismo/alcohol de la forma anterior (`{ activo: boolean }`): se deduce
 * `estado`. Va en la propiedad PADRE: class-transformer no llama al
 * `@Transform` de una clave que no viene (`estado`).
 */
const legacyEstado = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'object' || value === null) return value;
  const record = value as { estado?: unknown; activo?: unknown };
  if (record.estado === undefined) {
    record.estado = legacyAnswer({ value: record.activo });
  }
  return value;
};

export class SmokingDto {
  @ApiProperty({ enum: CONDITION_STATUSES, description: ANSWER_DESCRIPTION })
  @IsIn(CONDITION_STATUSES)
  estado!: ConditionStatus;

  @ApiPropertyOptional({ minimum: 0, description: 'Solo con «Sí».' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  porDia?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Solo con «Sí».' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  anios?: number;
}

export class AlcoholDto {
  @ApiProperty({ enum: CONDITION_STATUSES, description: ANSWER_DESCRIPTION })
  @IsIn(CONDITION_STATUSES)
  estado!: ConditionStatus;

  @ApiPropertyOptional({ description: 'Solo con «Sí».' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  frecuencia?: string;
}

export class OralHygieneDto {
  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  cepilladoPorDia?: number;

  @ApiPropertyOptional({
    enum: CONDITION_STATUSES,
    description: ANSWER_DESCRIPTION,
  })
  @IsOptional()
  @Transform(legacyAnswer)
  @IsIn(CONDITION_STATUSES)
  hilo?: ConditionStatus;

  @ApiPropertyOptional({
    enum: CONDITION_STATUSES,
    description: ANSWER_DESCRIPTION,
  })
  @IsOptional()
  @Transform(legacyAnswer)
  @IsIn(CONDITION_STATUSES)
  enjuague?: ConditionStatus;

  @ApiPropertyOptional({
    enum: CONDITION_STATUSES,
    description: ANSWER_DESCRIPTION,
  })
  @IsOptional()
  @Transform(legacyAnswer)
  @IsIn(CONDITION_STATUSES)
  cremaConFluor?: ConditionStatus;
}

/**
 * Hábitos tri-estado. Las versiones guardadas antes (booleanos) se devuelven
 * ya en esta forma: true «Sí», false «No», ausente «Sin responder».
 */
export class HabitsDto {
  @ApiPropertyOptional({ type: SmokingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SmokingDto)
  @Transform(legacyEstado)
  tabaquismo?: SmokingDto;

  @ApiPropertyOptional({ type: AlcoholDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AlcoholDto)
  @Transform(legacyEstado)
  alcohol?: AlcoholDto;

  @ApiPropertyOptional({
    enum: CONDITION_STATUSES,
    description: ANSWER_DESCRIPTION,
  })
  @IsOptional()
  @Transform(legacyAnswer)
  @IsIn(CONDITION_STATUSES)
  sustancias?: ConditionStatus;

  @ApiPropertyOptional({
    enum: CONDITION_STATUSES,
    description: ANSWER_DESCRIPTION,
  })
  @IsOptional()
  @Transform(legacyAnswer)
  @IsIn(CONDITION_STATUSES)
  bruxismo?: ConditionStatus;

  @ApiPropertyOptional({ type: OralHygieneDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OralHygieneDto)
  higieneOral?: OralHygieneDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  dieta?: string;
}

/* ── Documentación únicamente (secciones aceptadas como JSON libre) ─────── */

export class DentalHistoryDto {
  @ApiPropertyOptional()
  motivoConsulta?: string;

  @ApiPropertyOptional({ description: 'Fecha ISO (YYYY-MM-DD).' })
  ultimaVisita?: string;

  @ApiPropertyOptional({ type: [String] })
  tratamientosPrevios?: string[];

  @ApiPropertyOptional()
  malasExperiencias?: string;

  @ApiPropertyOptional()
  sangradoEncias?: boolean;

  @ApiPropertyOptional()
  sensibilidad?: boolean;

  @ApiPropertyOptional()
  atm?: boolean;

  @ApiPropertyOptional()
  ortodonciaPrevia?: boolean;

  @ApiPropertyOptional()
  enfPeriodontal?: boolean;
}

export class SurgeryDto {
  @ApiProperty({ example: 'Extracción de cordal' })
  descripcion!: string;

  @ApiPropertyOptional({ description: 'Fecha ISO (YYYY-MM-DD).' })
  fecha?: string;
}

export class VitalSignsDto {
  @ApiPropertyOptional()
  sistolica?: number;

  @ApiPropertyOptional()
  diastolica?: number;

  @ApiPropertyOptional({ description: 'Frecuencia cardíaca.' })
  fc?: number;

  @ApiPropertyOptional({ description: 'Frecuencia respiratoria.' })
  fr?: number;

  @ApiPropertyOptional()
  temp?: number;

  @ApiPropertyOptional()
  spo2?: number;

  @ApiPropertyOptional()
  peso?: number;

  @ApiPropertyOptional()
  talla?: number;

  @ApiPropertyOptional()
  glucometria?: number;
}

/** DERIVADO por el backend (`deriveSafetyFlags`); nunca se acepta del cliente. */
export class SafetyFlagsDto {
  @ApiProperty({
    description:
      'DERIVADA: true solo con un «Sí» explícito al embarazo (`pregnancy`). No dice si se contestó «No».',
  })
  embarazo!: boolean;

  @ApiPropertyOptional()
  semanasEmbarazo?: number;

  @ApiProperty()
  anticoagulantes!: boolean;

  @ApiProperty()
  bifosfonatos!: boolean;

  @ApiProperty()
  diabetes!: boolean;

  @ApiProperty()
  profilaxisAntibiotica!: boolean;

  @ApiProperty()
  alergiaAnestesico!: boolean;

  @ApiProperty()
  alergiaPenicilina!: boolean;

  @ApiProperty()
  alergiaLatex!: boolean;
}
