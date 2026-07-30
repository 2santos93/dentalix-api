import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { TreatmentPlanStatus } from '@prisma/client';

// All fields optional (partial update: change status and/or notes and/or
// currency). NO `tenantId` field — same rationale as UpdateAppointmentDto.
// `currency` is validated against the seeded `currencies` table by
// UpdateTreatmentPlanUseCase ONLY when provided — an omitted `currency`
// leaves the plan's existing currency untouched.
export class UpdateTreatmentPlanDto {
  @ApiPropertyOptional({ enum: TreatmentPlanStatus })
  @IsOptional()
  @IsEnum(TreatmentPlanStatus)
  status?: TreatmentPlanStatus;

  @ApiPropertyOptional({ example: 'USD', description: 'ISO 4217' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
