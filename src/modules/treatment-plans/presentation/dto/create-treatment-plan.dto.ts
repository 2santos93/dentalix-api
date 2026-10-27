import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

// NOTE: deliberately NO `tenantId`/`patientId`/`status`/`createdById` field —
// tenant comes from the guarded request context, `patientId` from the route
// param, `status` always starts at the schema default (DRAFT), and
// `createdById` is sourced from `req.user.sub` in the controller, never from
// the client body (same convention as CreateAppointmentDto). `currency` IS
// accepted here (optional; without it, the active location's currency — validated against the seeded
// `currencies` table by CreateTreatmentPlanUseCase, never here: DTO-level
// `@IsString` only rules out non-string input).
export class CreateTreatmentPlanDto {
  @ApiPropertyOptional({
    example: 'USD',
    description:
      'ISO 4217 (si se omite, la moneda de la sede activa o la común de la clínica)',
  })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
