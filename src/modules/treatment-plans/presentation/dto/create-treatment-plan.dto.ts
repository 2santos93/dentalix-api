import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

// NOTE: deliberately NO `tenantId`/`patientId`/`status`/`createdById` field —
// tenant comes from the guarded request context, `patientId` from the route
// param, `status` always starts at the schema default (DRAFT), and
// `createdById` is sourced from `req.user.sub` in the controller, never from
// the client body (same convention as CreateAppointmentDto).
export class CreateTreatmentPlanDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
