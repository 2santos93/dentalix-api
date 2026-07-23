import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

// NOTE: deliberately NO `tenantId`/`version`/`patientId`/`createdById` field —
// tenant comes from the guarded request context, `patientId` from the route
// param, `version` is computed by the repository (append-only), and
// `createdById` from `req.user.sub` (same convention as CreatePatientDto /
// CreateCatalogItemDto). All fields optional: an anamnesis can be partially
// filled.
export class SaveMedicalHistoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  allergies?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  chronicConditions?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  currentMedications?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  habits?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  medicalAlerts?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
