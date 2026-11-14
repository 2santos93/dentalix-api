import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import {
  CALENDAR_ALARM_RANGE_MESSAGE,
  LEAD_RANGE_MESSAGE,
  MAX_CALENDAR_ALARM_HOURS,
  MAX_LEAD_HOURS,
  MAX_REMINDER_LEADS,
  MIN_LEAD_HOURS,
  TOO_MANY_LEADS_MESSAGE,
} from '../../domain/reminder-lead-hours';

/** Ajustes de recordatorio de una sede (DX-026). */
export class LocationReminderSettingsDto {
  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ example: 'Sede principal' })
  locationName!: string;

  @ApiProperty({ description: 'Por defecto, false (sede sin configurar)' })
  enabled!: boolean;

  @ApiProperty({
    type: [Number],
    description: `Horas antes del inicio en que sale cada email, de mayor a menor (máx. ${MAX_REMINDER_LEADS}, ${MIN_LEAD_HOURS}..${MAX_LEAD_HOURS})`,
    example: [48, 2],
  })
  leadHours!: number[];

  @ApiProperty({
    minimum: 0,
    maximum: MAX_CALENDAR_ALARM_HOURS,
    description:
      'DX-469: horas antes de la cita de la alarma del evento «Añadir a mi calendario» (0 = sin alarma). Por defecto 24.',
    example: 24,
  })
  calendarAlarmHours!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'null = la sede nunca se configuró',
  })
  updatedAt!: Date | null;
}

export class UpdateReminderSettingsDto {
  @ApiProperty({
    description: 'Activar o desactivar los recordatorios de la sede',
  })
  @IsBoolean({
    message: 'Indica si los recordatorios están activos (sí o no).',
  })
  enabled!: boolean;

  @ApiProperty({
    type: [Number],
    minItems: 0,
    maxItems: MAX_REMINDER_LEADS,
    description: `Horas antes (enteros ${MIN_LEAD_HOURS}..${MAX_LEAD_HOURS}, sin repetir). Activo exige al menos una.`,
    example: [48, 2],
  })
  @IsArray({ message: 'Las antelaciones deben ser una lista de horas.' })
  @ArrayMaxSize(MAX_REMINDER_LEADS, { message: TOO_MANY_LEADS_MESSAGE })
  @IsInt({ each: true, message: LEAD_RANGE_MESSAGE })
  @Min(MIN_LEAD_HOURS, { each: true, message: LEAD_RANGE_MESSAGE })
  @Max(MAX_LEAD_HOURS, { each: true, message: LEAD_RANGE_MESSAGE })
  leadHours!: number[];

  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_CALENDAR_ALARM_HOURS,
    description:
      'DX-469: horas antes de la alarma de «Añadir a mi calendario» (0 la quita). Sin el campo, se conserva.',
    example: 24,
  })
  @IsOptional()
  @IsInt({ message: CALENDAR_ALARM_RANGE_MESSAGE })
  @Min(0, { message: CALENDAR_ALARM_RANGE_MESSAGE })
  @Max(MAX_CALENDAR_ALARM_HOURS, { message: CALENDAR_ALARM_RANGE_MESSAGE })
  calendarAlarmHours?: number;
}
