import { ApiProperty } from '@nestjs/swagger';
import { AppointmentStatus } from '@prisma/client';
import { OverdueBalanceDto } from '../../../collections/presentation/dto/collections.dto';
import { CoverageSummaryDto } from '../../../patient-coverages/presentation/dto/coverage-summary.dto';
import { AppointmentTypeSummaryDto } from '../../../appointment-types/presentation/dto/appointment-type.dto';
import {
  APPOINTMENT_WARNING_CODES,
  type AppointmentWarningCode,
} from '../../domain/entities/appointment.entity';

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

  @ApiProperty({
    description:
      'DX-210: «Adelantar si hay hueco». Se apaga al moverla a un hueco libre.',
  })
  wantsEarlier!: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'DX-200: cuándo recepción marcó «Llegó» (reloj del servidor). null en las citas antiguas o si se deshizo la llegada.',
  })
  arrivedAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'DX-200: cuándo pasó al sillón.',
  })
  seatedAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'DX-200: cuándo quedó listo para cobrar.',
  })
  readyForCheckoutAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

/**
 * Respuesta de agendar o mover una cita (DX-122): la cita y los avisos que no
 * impiden la operación, en español (p. ej. «La cita cae en un bloqueo que
 * permite agendar: Almuerzo (13:00–14:00).»). Vacío si no hay ninguno.
 */
export class AppointmentWriteDto extends AppointmentDto {
  @ApiProperty({
    type: [String],
    description:
      'Avisos en español que no impiden la operación (p. ej. «Fuera del horario del profesional en Sede Norte (jueves 22/10: 14:00–19:00).»).',
  })
  warnings!: string[];

  @ApiProperty({
    enum: APPOINTMENT_WARNING_CODES,
    enumName: 'AppointmentWarningCode',
    isArray: true,
    description:
      'DX-233: código de cada aviso, en el mismo orden que `warnings`: SCHEDULE_BLOCK (bloqueo que deja agendar, DX-122) o PROVIDER_OFF_SCHEDULE (fuera del horario del profesional en la sede).',
  })
  warningCodes!: AppointmentWarningCode[];
}

/**
 * Una cita de GET /appointments (la agenda) con la marca «Saldo vencido» de su
 * paciente (DX-150). El importe (`balance.amounts`) solo llega a ADMIN y
 * RECEPTION; DENTIST y ASSISTANT ven la marca y los días. `coverage` (DX-153)
 * resume la cobertura principal del paciente, sin número de afiliado.
 */
export class AppointmentListItemDto extends AppointmentDto {
  @ApiProperty({ type: OverdueBalanceDto })
  balance!: OverdueBalanceDto;

  @ApiProperty({ type: CoverageSummaryDto })
  coverage!: CoverageSummaryDto;
}
