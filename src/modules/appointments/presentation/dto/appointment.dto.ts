import { ApiProperty } from '@nestjs/swagger';
import { AppointmentStatus } from '@prisma/client';
import { AppointmentTypeSummaryDto } from '../../../appointment-types/presentation/dto/appointment-type.dto';

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

  @ApiProperty({ format: 'uuid', description: 'Sede donde ocurre la cita.' })
  locationId!: string;

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

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  appointmentTypeId!: string | null;

  @ApiProperty({
    type: AppointmentTypeSummaryDto,
    nullable: true,
    description:
      'DX-121: tipo embebido (nombre, duración, color #RRGGBB). Se mantiene aunque el tipo se desactive o retire después.',
  })
  appointmentType!: AppointmentTypeSummaryDto | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Cuándo se generó el enlace de confirmación vigente (DX-005). null si nunca se envió o si la cita se reagendó / cambió de estado después.',
  })
  confirmationSentAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'El paciente pidió que lo llamen desde el enlace de confirmación (la cita sigue SCHEDULED).',
  })
  callbackRequestedAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}
