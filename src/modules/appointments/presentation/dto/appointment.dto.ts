import { ApiProperty } from '@nestjs/swagger';
import { AppointmentStatus } from '@prisma/client';

// Response shape for Appointment endpoints — documents the Appointment
// entity contract for Swagger (same convention as BrandingDto /
// StaffMemberDto / PatientDto). The use cases already return values shaped
// exactly like this (Appointment entity, see
// ../../domain/entities/appointment.entity.ts); this class exists purely
// for `@ApiProperty` documentation, not for input validation.
export class AppointmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Patient's first name, joined so a client can label the appointment without fetching the patient list. Null when the join is unavailable.",
  })
  patientFirstName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  patientLastName!: string | null;

  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty({ format: 'date-time' })
  start!: Date;

  @ApiProperty({ format: 'date-time' })
  end!: Date;

  @ApiProperty({ enum: AppointmentStatus })
  status!: AppointmentStatus;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}
