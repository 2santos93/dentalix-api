import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
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
 * `Allergy`/`Condition`/`Medication` are the VALIDATED input classes (they
 * carry class-validator decorators and are `@ValidateNested`-ed by the save
 * DTO). The rest are DOCUMENTATION-ONLY: the backend still accepts those
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

  @ApiProperty({ enum: CONDITION_STATUSES })
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

/* ── Documentación únicamente (secciones aceptadas como JSON libre) ─────── */

export class SmokingDto {
  @ApiProperty()
  activo!: boolean;

  @ApiPropertyOptional()
  porDia?: number;

  @ApiPropertyOptional()
  anios?: number;
}

export class AlcoholDto {
  @ApiProperty()
  activo!: boolean;

  @ApiPropertyOptional()
  frecuencia?: string;
}

export class OralHygieneDto {
  @ApiPropertyOptional()
  cepilladoPorDia?: number;

  @ApiPropertyOptional()
  hilo?: boolean;

  @ApiPropertyOptional()
  enjuague?: boolean;

  @ApiPropertyOptional()
  cremaConFluor?: boolean;
}

export class HabitsDto {
  @ApiPropertyOptional({ type: SmokingDto })
  tabaquismo?: SmokingDto;

  @ApiPropertyOptional({ type: AlcoholDto })
  alcohol?: AlcoholDto;

  @ApiPropertyOptional()
  sustancias?: boolean;

  @ApiPropertyOptional()
  bruxismo?: boolean;

  @ApiPropertyOptional({ type: OralHygieneDto })
  higieneOral?: OralHygieneDto;

  @ApiPropertyOptional()
  dieta?: string;
}

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
  @ApiProperty()
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
