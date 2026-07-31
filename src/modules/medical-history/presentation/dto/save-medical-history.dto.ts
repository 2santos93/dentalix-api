import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  AllergyType,
  AllergySeverity,
  ConditionStatus,
  Habits,
  DentalHistory,
  Surgery,
  VitalSigns,
} from '../../domain/entities/medical-history.entity';

// Nested classes are structurally identical to the domain's Allergy/
// Condition/Medication interfaces (Task 2) — enum fields are typed with the
// domain union (not `string`) so `SaveMedicalHistoryDto` is structurally
// assignable to `MedicalHistoryVersionData` at the controller call site,
// with no cast.
class AllergyDto {
  @IsString() alergeno!: string;
  @IsEnum(['MEDICAMENTO', 'MATERIAL', 'ALIMENTO', 'AMBIENTAL'])
  tipo!: AllergyType;
  @IsOptional() @IsString() reaccion?: string;
  @IsEnum(['LEVE', 'MODERADA', 'ANAFILAXIA']) severidad!: AllergySeverity;
  @IsBoolean() esAlerta!: boolean;
}
class ConditionDto {
  @IsString() codigo!: string;
  @IsString() etiqueta!: string;
  @IsEnum(['SI', 'NO', 'DESCONOCE']) estado!: ConditionStatus;
  @IsBoolean() esAlerta!: boolean;
  @IsOptional() @IsString() nota?: string;
}
class MedicationDto {
  @IsString() nombre!: string;
  @IsOptional() @IsString() dosis?: string;
  @IsOptional() @IsString() frecuencia?: string;
  @IsOptional() @IsString() motivo?: string;
  @IsBoolean() esAlerta!: boolean;
}

// NOTE: deliberately NO `tenantId`/`version`/`patientId`/`createdById` field —
// tenant comes from the guarded request context, `patientId` from the route
// param, `version` is computed by the repository (append-only), and
// `createdById` from `req.user.sub` (same convention as CreatePatientDto /
// CreateCatalogItemDto). All fields optional: an anamnesis can be partially
// filled.
export class SaveMedicalHistoryDto {
  @ApiPropertyOptional({ type: [AllergyDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllergyDto)
  allergies?: AllergyDto[];

  @ApiPropertyOptional({ type: [ConditionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConditionDto)
  conditions?: ConditionDto[];

  @ApiPropertyOptional({ type: [MedicationDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MedicationDto)
  medications?: MedicationDto[];

  // habits/dentalHistory/vitalSigns/surgeries: objetos libres validados como
  // JSON (v1) — se validan por forma en el frontend; aquí se aceptan tal
  // cual (tipados con las interfaces de dominio para que el DTO sea
  // estructuralmente compatible con `MedicalHistoryVersionData`).
  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  habits?: Habits;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  dentalHistory?: DentalHistory;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  surgeries?: Surgery[];

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  vitalSigns?: VitalSigns;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  familyHistory?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  embarazo?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  semanasEmbarazo?: number;
}
