import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { AppointmentStatus } from '@prisma/client';
import { OverdueBalanceDto } from '../../../collections/presentation/dto/collections.dto';
import { CoverageSummaryDto } from '../../../patient-coverages/presentation/dto/coverage-summary.dto';
import { AppointmentTypeSummaryDto } from '../../../appointment-types/presentation/dto/appointment-type.dto';
import { MedicalAlertFlagsDto } from '../../../medical-history/presentation/dto/medical-alerts.dto';
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
  @ApiProperty({ type: [String], format: 'uuid' })
  planItemIds!: string[];
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
/**
 * DX-273 (revisión DX-271, I2): un tratamiento de la cita que sigue reservado
 * en OTRA cita viva (la reserva se quedó allí al marcar «Llegó»).
 */
export class PlanItemReservedElsewhereDto {
  @ApiProperty({ format: 'uuid' })
  planItemId!: string;

  @ApiProperty({
    description: 'Nombre del procedimiento (catálogo, en español).',
    example: 'Implante',
  })
  name!: string;

  @ApiProperty({ example: '36' })
  toothNumber!: string;

  @ApiProperty({
    description:
      'DX-293: la cita que lo reserva es de hoy (día civil de su sede) con el paciente en la clínica (ARRIVED, IN_CHAIR o READY_FOR_CHECKOUT). Entonces «Traer a esta cita» responde 409 (DX-288): la web no lo ofrece y explica dónde está la reserva. Una titular olvidada en la clínica de un día anterior o una cita futura: false.',
    example: false,
  })
  heldInClinic!: boolean;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'La cita que lo reserva. null si su sede no está permitida al usuario (DX-089); solo pasa con heldInClinic true: las demás reservas de sedes no permitidas no se listan.',
  })
  appointmentId!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Inicio de esa cita. null si su sede no está permitida.',
  })
  start!: Date | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Sede de esa cita. null si no está permitida.',
  })
  locationId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nombre de la sede de esa cita. null si no está permitida.',
    example: 'Sede Norte',
  })
  locationName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Zona IANA de esa sede: la fecha se muestra en ella. null si no está permitida.',
    example: 'America/Bogota',
  })
  timeZone!: string | null;
}

/** DX-273: el mínimo de una visita del plan antes y después de la salida. */
export class VisitMinimumChangeDto {
  @ApiProperty({ format: 'uuid' })
  planId!: string;

  @ApiProperty({ description: 'Visita siguiente (2 si la cita era de la 1).' })
  visit!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2027-01-20',
    description:
      'Mínimo (día civil en la zona de la sede del plan) antes de sacar la cita de COMPLETED. null = sin mínimo clínico.',
  })
  minimumDayBefore!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'Mínimo recalculado: la última cita de la visita anterior que SIGUE completada más el intervalo. null = ninguna sigue completada (o intervalo 0): se puede agendar desde hoy.',
  })
  minimumDayAfter!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'La cita completada que fija ahora el mínimo, o null.',
  })
  anchorAppointmentIdAfter!: string | null;
}

/** DX-273: resultado de sacar una cita de COMPLETED. */
export class CompletedExitDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Fila de `appointment_status_reversals` con el motivo; el `audit_event` COMPLETED_EXIT la enlaza en `params.reversalId`.',
  })
  reversalId!: string;

  @ApiProperty({ description: 'El motivo, recortado.' })
  reason!: string;

  @ApiProperty({ type: [VisitMinimumChangeDto] })
  visitMinimums!: VisitMinimumChangeDto[];
}

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

  @ApiProperty({
    type: [PlanItemReservedElsewhereDto],
    description:
      'DX-273: tratamientos de esta cita que siguen reservados en OTRA cita viva (p. ej. al marcar «Llegó», la reserva se quedó en la cita futura). Solo citas de sedes permitidas al usuario (DX-089): las de otras sedes se omiten, salvo la de hoy con el paciente en la clínica, que sale con `heldInClinic` y sin cita, hora ni sede (DX-293). Vacío en una cita cancelada, no-show o completada. Si la cita que lo reservaba se cancela, se marca no-show o lo quita, la cita más temprana con el paciente en la clínica recupera la reserva en esa misma transacción (auditado `PLAN_ITEM_RESERVATION_RECOVERED`). Para moverla: `POST /appointments/:id/plan-items/:planItemId/claim` (no con `heldInClinic`: daría 409).',
  })
  planItemsReservedElsewhere!: PlanItemReservedElsewhereDto[];

  @ApiPropertyOptional({
    type: CompletedExitDto,
    description:
      'DX-273: solo al sacar la cita de COMPLETED. El motivo y cómo queda el mínimo de la visita siguiente de cada plan afectado.',
  })
  completedExit?: CompletedExitDto;
}

/**
 * Una cita de GET /appointments (la agenda) con la marca «Saldo vencido» de su
 * paciente (DX-150). El importe (`balance.amounts`) solo llega a ADMIN y
 * RECEPTION; DENTIST y ASSISTANT ven la marca y los días. `coverage` (DX-153)
 * resume la cobertura principal del paciente, sin número de afiliado.
 * `medicalAlerts` (DX-247): solo banderas de la anamnesis, nunca su contenido.
 */
export class AppointmentListItemDto extends OmitType(AppointmentDto, [
  'notes',
] as const) {
  @ApiProperty({ type: OverdueBalanceDto })
  balance!: OverdueBalanceDto;

  @ApiProperty({ type: CoverageSummaryDto })
  coverage!: CoverageSummaryDto;

  @ApiProperty({
    type: MedicalAlertFlagsDto,
    description:
      'DX-247: banderas médicas del paciente (alerta, premedicación, anamnesis al día / caducada / ausente). Sin alérgenos, condiciones, medicamentos ni notas.',
  })
  medicalAlerts!: MedicalAlertFlagsDto;
}
