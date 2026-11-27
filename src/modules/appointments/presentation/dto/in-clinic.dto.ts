import { OrthoBalanceFlagDto } from '../../../orthodontics/presentation/dto/ortho.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { AppointmentArrivalSource, TriageFlag } from '@prisma/client';
import {
  CHECK_IN_PENDING,
  type CheckInPending,
} from '../../../self-check-in/domain/check-in-rules';
import { IN_CLINIC_STATUSES } from '../../domain/patient-flow';
import { MedicalAlertFlagsDto } from '../../../medical-history/presentation/dto/medical-alerts.dto';
import { PlanItemReservedElsewhereDto } from './appointment.dto';
import { ChairSummaryDto } from '../../../chairs/presentation/dto/chair.dto';
import { HOUR_CYCLES } from '../../../../shared/locations/location-regional';
import type { HourCycle } from '../../../../shared/format/regional-format';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class InClinicQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-19',
    description:
      'Día civil (zona de la sede). Por defecto, hoy en la sede con el reloj del servidor.',
  })
  @IsOptional()
  @Matches(CIVIL_DATE, {
    message: 'La fecha tiene que tener el formato AAAA-MM-DD',
  })
  date?: string;
}

/**
 * Una persona del panel: nombre y horas, sin historia clínica. Desde DX-470,
 * también la urgencia y su triaje de recepción.
 */
export class InClinicItemDto {
  @ApiProperty({ format: 'uuid' })
  appointmentId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ type: String, nullable: true })
  patientFirstName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  patientLastName!: string | null;

  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty({ type: String, nullable: true })
  providerName!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'DX-492: el sillón de la cita.',
  })
  chairId!: string | null;

  @ApiProperty({ type: () => ChairSummaryDto, nullable: true })
  chair!: ChairSummaryDto | null;

  @ApiProperty({ format: 'date-time' })
  start!: Date;

  @ApiProperty({ format: 'date-time' })
  end!: Date;

  @ApiProperty({ enum: [...IN_CLINIC_STATUSES] })
  status!: (typeof IN_CLINIC_STATUSES)[number];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  arrivedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  seatedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readyForCheckoutAt!: Date | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'DX-588: turno del día en la sede, dado al marcar «Llegó» (estable mientras dure la visita; el que ve el paciente en la pantalla de sala de espera en modo «Número de turno»). null si llegó antes de DX-588.',
  })
  turnNumber!: number | null;

  @ApiProperty({
    enum: AppointmentArrivalSource,
    enumName: 'AppointmentArrivalSource',
    nullable: true,
    description:
      'DX-265: la llegada la marcó el propio paciente con «Ya llegué»: PATIENT_LINK (enlace de la cita) o SEDE_QR (QR de la sede). null = la marcó el personal.',
  })
  arrivalSource!: AppointmentArrivalSource | null;

  @ApiProperty({
    enum: CHECK_IN_PENDING,
    enumName: 'CheckInPending',
    isArray: true,
    description:
      'DX-265: solo para quien llegó por su cuenta y sigue esperando: lo que recepción tiene que resolver (por eso la página le dijo «Pase por recepción»). ANAMNESIS: ausente o caducada (DX-247). CONSENT: sin autorización de datos (general o de salud) o con un consentimiento por firmar a distancia. PATIENT_DATA: falta documento, fecha de nacimiento o teléfono. LATE: llegó más tarde que el umbral de la sede. Vacío en el resto.',
  })
  checkInPending!: CheckInPending[];

  @ApiProperty({
    description:
      'Minutos (enteros, reloj del servidor) en el grupo actual: esperando desde la llegada, en el sillón desde que se sentó, o por cobrar desde que quedó listo.',
  })
  minutesInStatus!: number;

  @ApiProperty({
    description:
      'Minutos que esperó desde la llegada hasta el sillón (o que lleva esperando).',
  })
  waitedMinutes!: number;

  @ApiProperty({
    enum: ['ON_TIME', 'LATE', 'VERY_LATE'],
    description:
      'Puntualidad de la llegada: ON_TIME (verde) a la hora o antes; LATE (naranja) hasta 5 min tarde; VERY_LATE (rojo) después.',
  })
  punctuality!: 'ON_TIME' | 'LATE' | 'VERY_LATE';

  @ApiProperty({
    type: [PlanItemReservedElsewhereDto],
    description:
      'DX-273: tratamientos de la cita reservados en OTRA cita viva (solo sedes permitidas al usuario; de otra sede, solo la de hoy con el paciente en la clínica, sin sus datos: DX-293). `heldInClinic` true: no se ofrece «Traer a esta cita». Vacío si no hay.',
  })
  planItemsReservedElsewhere!: PlanItemReservedElsewhereDto[];

  @ApiProperty({
    type: MedicalAlertFlagsDto,
    description:
      'DX-247: la misma alerta médica que la tarjeta de la agenda (solo banderas).',
  })
  medicalAlerts!: MedicalAlertFlagsDto;
  @ApiProperty({
    type: OrthoBalanceFlagDto,
    description:
      'DX-285: la misma marca «Ortodoncia: saldo vencido» que la tarjeta de la agenda (sin importe).',
  })
  orthoBalance!: OrthoBalanceFlagDto;
  @ApiProperty({
    description:
      'DX-470: la cita es de un tipo de urgencia (insignia «Urgencia» en el panel).',
  })
  urgent!: boolean;

  @ApiProperty({ description: 'DX-470: llegó sin cita («Atender sin cita»).' })
  walkIn!: boolean;

  @ApiProperty({ description: 'DX-470: atendida en sobrecupo.' })
  overbooked!: boolean;

  @ApiProperty({
    enum: TriageFlag,
    enumName: 'TriageFlag',
    isArray: true,
    description:
      'DX-470: señales de triaje de recepción. Solo para el personal con acceso a la sede del panel.',
  })
  triageFlags!: TriageFlag[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'DX-470: nota de triaje (≤ 200).',
  })
  triageNote!: string | null;
}

/**
 * DX-275: una cita del día ya completada que el informe «Tiempos» deja fuera
 * (la marca «sin tiempos» del panel). Nombre y horas, sin historia clínica.
 */
export class CompletedWithoutTimesItemDto {
  @ApiProperty({ format: 'uuid' })
  appointmentId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ type: String, nullable: true })
  patientFirstName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  patientLastName!: string | null;

  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty({ type: String, nullable: true })
  providerName!: string | null;

  @ApiProperty({ format: 'date-time' })
  start!: Date;

  @ApiProperty({ format: 'date-time' })
  end!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  arrivedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  seatedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readyForCheckoutAt!: Date | null;

  @ApiProperty({
    enum: ['WITHOUT_TIMES', 'INCOHERENT'],
    description:
      'WITHOUT_TIMES: se completó sin alguna de las tres horas (llegó, en sillón, listo para cobrar). INCOHERENT: tiene las tres pero fuera de los umbrales del informe «Tiempos» (GET /reports/timing, `thresholds`). En los dos casos el informe no la mide.',
  })
  timingIssue!: 'WITHOUT_TIMES' | 'INCOHERENT';

  @ApiProperty({
    enum: ['ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT'],
    isArray: true,
    description: 'Los pasos sin hora, en orden; vacío en INCOHERENT.',
  })
  missingMarks!: ('ARRIVED' | 'IN_CHAIR' | 'READY_FOR_CHECKOUT')[];
}

export class InClinicViewDto {
  @ApiProperty({ example: '2026-10-19' })
  date!: string;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ example: 'UTC' })
  timeZone!: string;

  @ApiProperty({
    example: 'en-US',
    description:
      'G1-B: formato regional (BCP 47) de la sede: las horas se pintan con él.',
  })
  locale!: string;

  @ApiProperty({
    enum: [...HOUR_CYCLES],
    description: 'G1-B: reloj de la sede (12 h o 24 h).',
  })
  hourCycle!: HourCycle;

  @ApiProperty({
    format: 'date-time',
    description: 'Reloj del servidor con el que se calcularon los minutos.',
  })
  now!: Date;

  @ApiProperty({
    enum: ['MINE', 'LOCATION'],
    description:
      'MINE: un DENTIST ve solo a sus pacientes («Te esperan»); LOCATION: toda la sede.',
  })
  scope!: 'MINE' | 'LOCATION';

  @ApiProperty({
    type: [InClinicItemDto],
    description: 'En espera (ARRIVED), quien más lleva esperando primero.',
  })
  waiting!: InClinicItemDto[];

  @ApiProperty({
    type: [InClinicItemDto],
    description: 'En sillón (IN_CHAIR).',
  })
  inChair!: InClinicItemDto[];

  @ApiProperty({
    type: [InClinicItemDto],
    description: 'Listo para cobrar (READY_FOR_CHECKOUT).',
  })
  readyForCheckout!: InClinicItemDto[];

  @ApiProperty({
    type: [CompletedWithoutTimesItemDto],
    description:
      'DX-275: citas del día ya completadas (en la sede del panel; a un DENTIST, solo las suyas) que el informe «Tiempos» no podrá medir, por hora de la cita: la marca «sin tiempos». Vacío si no hay.',
  })
  completedWithoutTimes!: CompletedWithoutTimesItemDto[];
}
