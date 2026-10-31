import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  AnswerStatus,
  DentalHistory,
  Surgery,
  VitalSigns,
} from '../../domain/entities/medical-history.entity';
import { ANSWER_STATUSES } from '../../domain/anamnesis-answers';
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

  @ApiPropertyOptional({
    type: [ConditionDto],
    description:
      'Solo las condiciones que se contestaron (Sí / No / No sabe). Una condición del checklist que no figura está «Sin responder»: nunca se interpreta como «No».',
  })
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

  // Hábitos tri-estado, validados (los booleanos de un cliente anterior se
  // traducen antes: ver HabitsDto). dentalHistory/vitalSigns/surgeries:
  // objetos libres validados como JSON (v1) — se validan por forma en el
  // frontend; aquí se aceptan tal cual.
  @ApiPropertyOptional({ type: HabitsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => HabitsDto)
  habits?: HabitsDto;

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

  @ApiPropertyOptional({
    enum: ANSWER_STATUSES,
    enumName: 'AnamnesisAnswer',
    description:
      'Embarazo: SI / NO / DESCONOCE («No sabe»). Ausente = «Sin responder». Solo el «Sí» enciende la alerta.',
  })
  @IsOptional()
  @IsIn(ANSWER_STATUSES)
  pregnancy?: AnswerStatus;

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'Deprecado: usar `pregnancy`. Solo `true` dice algo («Sí»); `false` se trata como sin responder. Si viene `pregnancy`, manda `pregnancy`.',
  })
  @IsOptional()
  @IsBoolean()
  embarazo?: boolean;

  @ApiPropertyOptional({ description: 'Solo con `pregnancy` = SI.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  semanasEmbarazo?: number;
}
