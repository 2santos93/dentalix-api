import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { TreatmentPlanStatus } from '@prisma/client';

// All fields optional (partial update: change status and/or notes). NO
// `tenantId` field — same rationale as UpdateAppointmentDto.
export class UpdateTreatmentPlanDto {
  @ApiPropertyOptional({ enum: TreatmentPlanStatus })
  @IsOptional()
  @IsEnum(TreatmentPlanStatus)
  status?: TreatmentPlanStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
