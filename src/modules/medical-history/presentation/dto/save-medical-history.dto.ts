import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  Habits,
  DentalHistory,
  Surgery,
  VitalSigns,
} from '../../domain/entities/medical-history.entity';
// Las partes viven en un archivo compartido para que el MISMO esquema
// documente request y response (ver anamnesis-parts.dto.ts).
import {
  AllergyDto,
  ConditionDto,
  MedicationDto,
  HabitsDto,
  DentalHistoryDto,
  SurgeryDto,
  VitalSignsDto,
} from './anamnesis-parts.dto';

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
  @ApiPropertyOptional({ type: HabitsDto })
  @IsOptional()
  habits?: Habits;

  @ApiPropertyOptional({ type: DentalHistoryDto })
  @IsOptional()
  dentalHistory?: DentalHistory;

  @ApiPropertyOptional({ type: [SurgeryDto] })
  @IsOptional()
  @IsArray()
  surgeries?: Surgery[];

  @ApiPropertyOptional({ type: VitalSignsDto })
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
