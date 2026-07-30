import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

// NOTE: deliberately NO `tenantId`/`patientId`/`status`/`createdById` field —
// tenant comes from the guarded request context, `patientId` from the route
// param, `status` always starts at the schema default (DRAFT), and
// `createdById` is sourced from `req.user.sub` in the controller, never from
// the client body (same convention as CreateAppointmentDto). `currency` IS
// accepted here (optional, default "USD" — validated against the seeded
// `currencies` table by CreateTreatmentPlanUseCase, never here: DTO-level
// `@IsString` only rules out non-string input).
export class CreateTreatmentPlanDto {
  @ApiPropertyOptional({
    example: 'USD',
    description: 'ISO 4217 (default USD)',
  })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
