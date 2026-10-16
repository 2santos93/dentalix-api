import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AppointmentStatus,
  WaitlistPriority,
  WaitlistStatus,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AppointmentTypeSummaryDto } from '../../../appointment-types/presentation/dto/appointment-type.dto';
import {
  WAITLIST_DISMISS_REASON_MAX,
  WAITLIST_MAX_PAGE_SIZE,
  WAITLIST_NOTE_MAX,
  WAITLIST_PREFERRED_WINDOW_MAX,
} from '../../domain/waitlist-rules';

export class WaitlistSourceAppointmentDto {
  @ApiProperty({ format: 'date-time' })
  start!: Date;

  @ApiProperty({ format: 'date-time' })
  end!: Date;

  @ApiProperty({
    enum: AppointmentStatus,
    description: 'CANCELLED o NO_SHOW al crearse.',
  })
  status!: AppointmentStatus;
}

/** Entrada de «Pendientes por agendar» (DX-122). */
export class WaitlistEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty()
  patientFirstName!: string;

  @ApiProperty()
  patientLastName!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Para llamarlo sin abrir la ficha.',
  })
  patientPhone!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Cita cancelada o no-show que la originó; null en un alta manual.',
  })
  sourceAppointmentId!: string | null;

  @ApiProperty({ type: WaitlistSourceAppointmentDto, nullable: true })
  sourceAppointment!: WaitlistSourceAppointmentDto | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  providerId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  appointmentTypeId!: string | null;

  @ApiProperty({ type: AppointmentTypeSummaryDto, nullable: true })
  appointmentType!: AppointmentTypeSummaryDto | null;

  @ApiProperty({
    minimum: 5,
    maximum: 480,
    multipleOf: 5,
    description: 'Duración de la cita a buscar.',
  })
  durationMinutes!: number;

  @ApiProperty({ enum: WaitlistPriority, enumName: 'WaitlistPriority' })
  priority!: WaitlistPriority;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: WAITLIST_PREFERRED_WINDOW_MAX,
  })
  preferredWindow!: string | null;

  @ApiProperty({ type: String, nullable: true, maxLength: WAITLIST_NOTE_MAX })
  note!: string | null;

  @ApiProperty({ enum: WaitlistStatus, enumName: 'WaitlistStatus' })
  status!: WaitlistStatus;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  resolvedAppointmentId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  dismissReason!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  resolvedById!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt!: Date | null;

  @ApiProperty({ format: 'date-time', description: 'Antigüedad en la lista.' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class WaitlistPageDto {
  @ApiProperty({ type: [WaitlistEntryDto] })
  items!: WaitlistEntryDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}

export class ListWaitlistQueryDto {
  @ApiPropertyOptional({
    enum: WaitlistStatus,
    enumName: 'WaitlistStatus',
    default: WaitlistStatus.OPEN,
  })
  @IsOptional()
  @IsEnum(WaitlistStatus)
  status?: WaitlistStatus;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Sede. Si falta, la del request (X-Location-Id) o todas.',
  })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: WAITLIST_MAX_PAGE_SIZE,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(WAITLIST_MAX_PAGE_SIZE)
  pageSize?: number;
}

export class CreateWaitlistEntryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  patientId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Si falta, la sede del request o la sede por defecto.',
  })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Profesional preferido.',
  })
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Tipo de cita activo: fija la duración si no viene.',
  })
  @IsOptional()
  @IsUUID()
  appointmentTypeId?: string;

  @ApiPropertyOptional({ minimum: 5, maximum: 480, multipleOf: 5, default: 30 })
  @IsOptional()
  @IsInt()
  durationMinutes?: number;

  @ApiPropertyOptional({
    enum: WaitlistPriority,
    enumName: 'WaitlistPriority',
    default: WaitlistPriority.NORMAL,
  })
  @IsOptional()
  @IsEnum(WaitlistPriority)
  priority?: WaitlistPriority;

  @ApiPropertyOptional({
    maxLength: WAITLIST_PREFERRED_WINDOW_MAX,
    example: 'Mañanas, antes de las 11',
  })
  @IsOptional()
  @IsString()
  @MaxLength(WAITLIST_PREFERRED_WINDOW_MAX)
  preferredWindow?: string;

  @ApiPropertyOptional({ maxLength: WAITLIST_NOTE_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(WAITLIST_NOTE_MAX)
  note?: string;
}

export class DismissWaitlistEntryDto {
  @ApiProperty({
    maxLength: WAITLIST_DISMISS_REASON_MAX,
    example: 'Prefiere otra clínica',
  })
  @IsString()
  @MaxLength(WAITLIST_DISMISS_REASON_MAX)
  reason!: string;
}

export class ScheduleFromWaitlistDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  providerId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  start!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Si falta, `start` + la duración de la entrada.',
  })
  @IsOptional()
  @IsDateString()
  end?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Si falta, el tipo de la entrada si sigue activo.',
  })
  @IsOptional()
  @IsUUID()
  appointmentTypeId?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
