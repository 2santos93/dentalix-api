import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { TriageFlag } from '@prisma/client';
import { IN_CLINIC_STATUSES } from '../../domain/patient-flow';
import { MedicalAlertFlagsDto } from '../../../medical-history/presentation/dto/medical-alerts.dto';
import { PlanItemReservedElsewhereDto } from './appointment.dto';
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
}
