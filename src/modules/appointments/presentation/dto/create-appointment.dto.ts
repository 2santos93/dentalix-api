import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUUID } from 'class-validator';

// NOTE: deliberately NO `tenantId`/`status`/`createdById` field — the tenant
// comes from the guarded request context (never the client, same convention
// as CreatePatientDto/CreateToothRecordDto); `status` always starts at the
// schema default (SCHEDULED); `createdById` is sourced from the authenticated
// user in the controller (req.user.sub), never from the client body.
export class CreateAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  patientId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  providerId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  start!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  end!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
