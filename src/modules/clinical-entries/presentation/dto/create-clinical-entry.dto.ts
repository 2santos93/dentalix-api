import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, MinLength } from 'class-validator';

// NOTE: deliberately NO `tenantId`/`patientId`/`performedById` field —
// tenant comes from the guarded request context, `patientId` from the route
// param, and `performedById` from `req.user.sub` (same convention as
// CreatePatientDto / SaveMedicalHistoryDto).
export class CreateClinicalEntryDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Defaults to now when omitted',
  })
  @IsOptional()
  @IsDateString()
  entryDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiProperty({ minLength: 1 })
  @IsString()
  @MinLength(1)
  notes!: string;
}
