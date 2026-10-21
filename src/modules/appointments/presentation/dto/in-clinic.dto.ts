import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { IN_CLINIC_STATUSES } from '../../domain/patient-flow';
import { MedicalAlertFlagsDto } from '../../../medical-history/presentation/dto/medical-alerts.dto';

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

/** Una persona del panel: nombre y horas, sin datos clínicos. */
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
    type: MedicalAlertFlagsDto,
    description:
      'DX-247: la misma alerta médica que la tarjeta de la agenda (solo banderas).',
  })
  medicalAlerts!: MedicalAlertFlagsDto;
}

export class InClinicViewDto {
  @ApiProperty({ example: '2026-10-19' })
  date!: string;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ example: 'America/Bogota' })
  timeZone!: string;

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
