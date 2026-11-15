import { ApiProperty } from '@nestjs/swagger';

/** DX-339: la última copia nocturna de la agenda de contingencia de una sede. */
export class ContingencyNightlyInfoDto {
  @ApiProperty({
    description: 'Hay una copia nocturna guardada para la sede.',
  })
  available!: boolean;

  @ApiProperty({
    description:
      'La copia es la de HOY en la zona de la sede (cubre hoy y mañana). false si no hay copia o es de un día anterior.',
  })
  current!: boolean;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-11-02',
    description:
      '«Hoy» (día civil en la zona de la sede) al generarla: cubre ese día y el siguiente. null sin copia.',
  })
  forDate!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo se generó (UTC). null sin copia.',
  })
  generatedAt!: Date | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 18,
    description:
      'Citas que lleva (sin canceladas ni inasistencias). null sin copia.',
  })
  appointmentCount!: number | null;
}

const EXPECTED_STATUSES = [
  'SCHEDULED',
  'CONFIRMED',
  'ARRIVED',
  'IN_CHAIR',
  'READY_FOR_CHECKOUT',
  'COMPLETED',
] as const;

/**
 * DX-405: una cita de la copia sin conexión de la agenda. Los mismos datos que
 * el PDF de contingencia, más el gabinete: nunca notas, motivo ni historia.
 */
export class OfflineAgendaAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  start!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  end!: Date;

  @ApiProperty({
    enum: EXPECTED_STATUSES,
    enumName: 'OfflineAgendaAppointmentStatus',
    description:
      'Estado de la cita (confirmación y flujo). Nunca CANCELLED ni NO_SHOW: no salen.',
  })
  status!: (typeof EXPECTED_STATUSES)[number];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Gabinete (sillón) de la cita; null sin sillón.',
  })
  chairName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Profesional; null si no se pudo leer.',
  })
  professionalName!: string | null;

  @ApiProperty({ example: 'María Pérez' })
  patientName!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Teléfono del paciente en formato internacional (región de la sede) o el texto guardado; null sin teléfono.',
  })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  appointmentTypeName!: string | null;

  @ApiProperty({
    description:
      'El paciente tiene una alerta médica o requiere premedicación: solo sí/no, sin el detalle (ver la ficha).',
  })
  medicalAlert!: boolean;
}

/** DX-405: la agenda de hoy y mañana de una sede para la copia sin conexión. */
export class OfflineAgendaDto {
  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ example: 'Sede Principal' })
  locationName!: string;

  @ApiProperty({
    example: 'America/Caracas',
    description: 'Zona IANA de la sede.',
  })
  timeZone!: string;

  @ApiProperty({ example: 'es-VE', description: 'Locale de la sede.' })
  locale!: string;

  @ApiProperty({ enum: ['h12', 'h23'], description: 'Reloj de la sede.' })
  hourCycle!: string;

  @ApiProperty({
    type: [String],
    example: ['2026-11-15', '2026-11-16'],
    description: 'Hoy y mañana (YYYY-MM-DD) en la zona de la sede.',
  })
  days!: string[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Cuándo se leyeron los datos (UTC).',
  })
  generatedAt!: Date;

  @ApiProperty({ type: [OfflineAgendaAppointmentDto] })
  appointments!: OfflineAgendaAppointmentDto[];
}
