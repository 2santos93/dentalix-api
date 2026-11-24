import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { HOUR_CYCLES } from '../../../../shared/locations/location-regional';
import type { HourCycle } from '../../../../shared/format/regional-format';
import { CHECK_IN_MINUTES_MAX } from '../../domain/check-in-rules';
import { CHECK_IN_DOCUMENT_MAX } from '../../domain/check-in-identity';

const ARRIVAL_STATES = [
  'AVAILABLE',
  'TOO_EARLY',
  'TOO_LATE',
  'ARRIVED',
  'UNAVAILABLE',
] as const;

// --- Ajustes (ADMIN) -----------------------------------------------------------

export class CheckInSettingsDto {
  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({
    description:
      'La página del enlace de la cita (DX-005) ofrece «Ya llegué». Por defecto, sí.',
  })
  linkEnabled!: boolean;

  @ApiProperty({
    minimum: 0,
    maximum: CHECK_IN_MINUTES_MAX,
    description:
      'Se puede marcar la llegada desde estos minutos antes del inicio (por defecto 30), siempre el día de la cita en la zona de la sede.',
  })
  minutesBefore!: number;

  @ApiProperty({
    minimum: 0,
    maximum: CHECK_IN_MINUTES_MAX,
    description: '…y hasta estos minutos después (por defecto 30).',
  })
  minutesAfter!: number;

  @ApiProperty({
    minimum: 0,
    maximum: CHECK_IN_MINUTES_MAX,
    description:
      'Llegar más tarde que esto (minutos tras el inicio) manda al paciente a recepción y queda como pendiente «Llegó tarde» (por defecto 10).',
  })
  lateMinutes!: number;

  @ApiProperty({
    description:
      'La sede tiene un QR de llegada activo (el token solo se ve al generarlo).',
  })
  qrActive!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  qrCreatedAt!: Date | null;
}

export class UpdateCheckInSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  linkEnabled?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: CHECK_IN_MINUTES_MAX })
  @IsOptional()
  @IsInt({ message: 'Los minutos van de 0 a 240.' })
  @Min(0, { message: 'Los minutos van de 0 a 240.' })
  @Max(CHECK_IN_MINUTES_MAX, { message: 'Los minutos van de 0 a 240.' })
  minutesBefore?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: CHECK_IN_MINUTES_MAX })
  @IsOptional()
  @IsInt({ message: 'Los minutos van de 0 a 240.' })
  @Min(0, { message: 'Los minutos van de 0 a 240.' })
  @Max(CHECK_IN_MINUTES_MAX, { message: 'Los minutos van de 0 a 240.' })
  minutesAfter?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: CHECK_IN_MINUTES_MAX })
  @IsOptional()
  @IsInt({ message: 'Los minutos van de 0 a 240.' })
  @Min(0, { message: 'Los minutos van de 0 a 240.' })
  @Max(CHECK_IN_MINUTES_MAX, { message: 'Los minutos van de 0 a 240.' })
  lateMinutes?: number;
}

export class CreatedCheckInQrDto extends CheckInSettingsDto {
  @ApiProperty({
    description:
      'Token del QR (`<host>/llegada/<token>`). SOLO en esta respuesta: en la BD queda su hash. Generar otro invalida el anterior.',
  })
  token!: string;
}

// --- Públicas -------------------------------------------------------------------

export class PublicClinicBrandingForCheckInDto {
  @ApiProperty()
  name!: string;

  @ApiProperty()
  primaryColor!: string;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;
}

export class PublicArrivalAppointmentDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Solo el nombre de pila.',
  })
  patientFirstName!: string | null;

  @ApiProperty({ format: 'date-time' })
  start!: Date;

  @ApiProperty()
  locationName!: string;

  @ApiProperty({ type: String, nullable: true })
  timeZone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  locale!: string | null;

  @ApiProperty({ enum: HOUR_CYCLES, nullable: true })
  hourCycle!: HourCycle | null;
}

export class PublicArrivalViewDto {
  @ApiProperty({
    enum: ARRIVAL_STATES,
    description:
      'AVAILABLE: se puede marcar ya. TOO_EARLY / TOO_LATE: hoy, fuera de la ventana de la sede. ARRIVED: ya consta la llegada. UNAVAILABLE: no se ofrece (otro día, cancelada, atendida, enlace sustituido, la sede no lo ofrece); la página dice «pasa por recepción» sin explicar por qué.',
  })
  state!: (typeof ARRIVAL_STATES)[number];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  opensAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closesAt!: Date | null;

  @ApiProperty({
    enum: ['TAKE_SEAT', 'SEE_RECEPTION'],
    nullable: true,
    description:
      'Con la llegada marcada y el paciente en la sala de espera: «Tome asiento» o «Pase por recepción» (algo pendiente: anamnesis, consentimiento, datos o retraso; nunca cuál).',
  })
  result!: 'TAKE_SEAT' | 'SEE_RECEPTION' | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'DX-588: turno del día, con la llegada marcada.',
  })
  turnNumber!: number | null;

  @ApiProperty({ type: PublicArrivalAppointmentDto, nullable: true })
  appointment!: PublicArrivalAppointmentDto | null;
}

export class PublicCheckInQrViewDto {
  @ApiProperty({ type: PublicClinicBrandingForCheckInDto, nullable: true })
  clinic!: PublicClinicBrandingForCheckInDto | null;

  @ApiProperty()
  locationName!: string;

  @ApiProperty({ type: String, nullable: true })
  timeZone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  locale!: string | null;

  @ApiProperty({ enum: HOUR_CYCLES, nullable: true })
  hourCycle!: HourCycle | null;
}

export class PublicCheckInIdentifyDto {
  @ApiProperty({
    example: 'V-12345678',
    description: `Número de documento tal como lo escribe el paciente (hasta ${CHECK_IN_DOCUMENT_MAX}). Se compara sin puntos, guiones ni espacios; «12345678» vale por «V-12345678».`,
  })
  @IsString()
  @MaxLength(CHECK_IN_DOCUMENT_MAX)
  documentNumber!: string;

  @ApiProperty({ example: '1990-04-15', description: 'AAAA-MM-DD.' })
  @IsString()
  @MaxLength(10)
  birthDate!: string;
}
