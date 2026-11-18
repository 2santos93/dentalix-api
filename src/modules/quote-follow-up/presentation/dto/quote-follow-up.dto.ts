import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import {
  FROM_HOUR_MESSAGE,
  MAX_FOLLOW_UP_STEPS,
  MAX_FROM_HOUR,
  MAX_OFFSET_DAYS,
  MAX_UNTIL_HOUR,
  MIN_FROM_HOUR,
  MIN_OFFSET_DAYS,
  MIN_UNTIL_HOUR,
  OFFSET_RANGE_MESSAGE,
  OFFSETS_COUNT_MESSAGE,
  UNTIL_HOUR_MESSAGE,
} from '../../domain/quote-follow-up-settings';

const SKIP_REASONS = [
  'SUPERSEDED',
  'TOO_LATE',
  'STOPPED_ACCEPTED',
  'STOPPED_REJECTED',
  'STOPPED_SCHEDULED',
  'EXPIRED',
  'OPTED_OUT',
  'CHANNEL_NONE',
  'CHANNEL_WHATSAPP',
  'NO_EMAIL',
  'NO_CONSENT',
  'NO_LINK_HOST',
  'NO_PROFESSIONAL',
] as const;

const SKIP_REASON_PROPERTY = {
  enum: SKIP_REASONS,
  enumName: 'QuoteFollowUpReason',
  description:
    'SUPERSEDED = había un aviso posterior ya vencido (solo sale el último); TOO_LATE = vencido hace más de 7 días; STOPPED_ACCEPTED / STOPPED_REJECTED / STOPPED_SCHEDULED = aceptado, rechazado o con cita (la secuencia se detiene); EXPIRED = presupuesto vencido; OPTED_OUT = baja de los avisos; CHANNEL_NONE / CHANNEL_WHATSAPP = el canal del paciente no es el email; NO_EMAIL = sin email (o un menor sin responsable con email); NO_CONSENT = consentimiento de datos revocado; NO_LINK_HOST = la clínica no tiene dirección web para los enlaces; NO_PROFESSIONAL = ningún odontólogo o administrador activo elaboró el plan.',
} as const;

/** Ajustes del seguimiento automático de una sede (DX-561). */
export class LocationQuoteFollowUpSettingsDto {
  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ example: 'Sede principal' })
  locationName!: string;

  @ApiProperty({ description: 'Por defecto, false (sede sin configurar)' })
  enabled!: boolean;

  @ApiProperty({
    type: [Number],
    example: [3, 10, 21],
    description: `Días tras presentar el presupuesto en que sale cada aviso (1–${MAX_FOLLOW_UP_STEPS}, de ${MIN_OFFSET_DAYS} a ${MAX_OFFSET_DAYS}, estrictamente crecientes). Sin configurar: 3, 10 y 21.`,
  })
  offsetsDays!: number[];

  @ApiProperty({
    minimum: MIN_FROM_HOUR,
    maximum: MAX_FROM_HOUR,
    example: 9,
    description:
      'Hora local (de la sede) desde la que salen. Sin configurar: 9.',
  })
  sendFromHour!: number;

  @ApiProperty({
    minimum: MIN_UNTIL_HOUR,
    maximum: MAX_UNTIL_HOUR,
    example: 19,
    description:
      'Hora local hasta la que salen (sin incluirla; 24 = medianoche). Sin configurar: 19.',
  })
  sendUntilHour!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'null = la sede nunca se configuró',
  })
  updatedAt!: Date | null;
}

export class UpdateQuoteFollowUpSettingsDto {
  @ApiProperty({
    description: 'Activar o desactivar el seguimiento en la sede',
  })
  @IsBoolean({
    message: 'Indica si el seguimiento automático está activo (sí o no).',
  })
  enabled!: boolean;

  @ApiProperty({
    type: [Number],
    minItems: 1,
    maxItems: MAX_FOLLOW_UP_STEPS,
    example: [3, 10, 21],
    description: `Días tras presentar (enteros ${MIN_OFFSET_DAYS}..${MAX_OFFSET_DAYS}, de menor a mayor y sin repetir).`,
  })
  @IsArray({ message: 'Los días de los avisos deben ser una lista.' })
  @ArrayMinSize(1, { message: OFFSETS_COUNT_MESSAGE })
  @ArrayMaxSize(MAX_FOLLOW_UP_STEPS, { message: OFFSETS_COUNT_MESSAGE })
  @IsInt({ each: true, message: OFFSET_RANGE_MESSAGE })
  @Min(MIN_OFFSET_DAYS, { each: true, message: OFFSET_RANGE_MESSAGE })
  @Max(MAX_OFFSET_DAYS, { each: true, message: OFFSET_RANGE_MESSAGE })
  offsetsDays!: number[];

  @ApiProperty({ minimum: MIN_FROM_HOUR, maximum: MAX_FROM_HOUR, example: 9 })
  @IsInt({ message: FROM_HOUR_MESSAGE })
  @Min(MIN_FROM_HOUR, { message: FROM_HOUR_MESSAGE })
  @Max(MAX_FROM_HOUR, { message: FROM_HOUR_MESSAGE })
  sendFromHour!: number;

  @ApiProperty({
    minimum: MIN_UNTIL_HOUR,
    maximum: MAX_UNTIL_HOUR,
    example: 19,
  })
  @IsInt({ message: UNTIL_HOUR_MESSAGE })
  @Min(MIN_UNTIL_HOUR, { message: UNTIL_HOUR_MESSAGE })
  @Max(MAX_UNTIL_HOUR, { message: UNTIL_HOUR_MESSAGE })
  sendUntilHour!: number;
}

/** Estado de la pausa del seguimiento de un presupuesto (DX-561, D6). */
export class QuoteFollowUpPauseDto {
  @ApiProperty({ format: 'uuid' })
  planId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'El grupo de opciones (plan raíz): la pausa vale para todas',
  })
  groupId!: string;

  @ApiProperty()
  paused!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  pausedAt!: Date | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  pausedById!: string | null;
}

export class QuoteFollowUpReportQueryDto {
  @ApiProperty({ example: '2026-11-01', description: 'Desde (AAAA-MM-DD)' })
  @IsString({ message: 'Indica desde qué día (AAAA-MM-DD).' })
  from!: string;

  @ApiProperty({
    example: '2026-11-30',
    description: 'Hasta (AAAA-MM-DD, incluido)',
  })
  @IsString({ message: 'Indica hasta qué día (AAAA-MM-DD).' })
  to!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Solo una sede' })
  @IsOptional()
  @IsUUID('all', { message: 'El identificador de la sede no es válido.' })
  locationId?: string;
}

export class FollowUpStepStatsDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description: '1..3; null en el total',
  })
  step!: number | null;
  @ApiProperty() sent!: number;
  @ApiProperty() opened!: number;
  @ApiProperty({
    description:
      'Enviados con alguna opción aceptada en los 14 días siguientes',
  })
  acceptedWithin14Days!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'abiertos ÷ enviados, en % (1 decimal)',
  })
  openRate!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'aceptados en 14 días ÷ enviados, en % (1 decimal)',
  })
  acceptanceRate!: number | null;
}

export class FollowUpSkipCountDto {
  @ApiProperty(SKIP_REASON_PROPERTY)
  reason!: (typeof SKIP_REASONS)[number];
  @ApiProperty() count!: number;
}

export class FollowUpReportDefinitionDto {
  @ApiProperty({
    enum: [
      'sent',
      'opened',
      'acceptedWithin14Days',
      'acceptanceRate',
      'skipped',
    ],
  })
  key!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ type: [String] }) howItIsCalculated!: string[];
}

class FollowUpReportPeriodDto {
  @ApiProperty({ format: 'date' }) from!: string;
  @ApiProperty({ format: 'date' }) to!: string;
}

class FollowUpReportFiltersDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;
}

class FollowUpReportLocationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

class FollowUpReportOptionsDto {
  @ApiProperty({ type: [FollowUpReportLocationDto] })
  locations!: FollowUpReportLocationDto[];
}

export class QuoteFollowUpReportDto {
  @ApiProperty({ type: FollowUpReportPeriodDto })
  period!: FollowUpReportPeriodDto;
  @ApiProperty({
    enum: ['CLINIC', 'OWN'],
    description:
      'CLINIC = toda la clínica visible; OWN = solo los presupuestos que elaboró quien consulta',
  })
  scope!: 'CLINIC' | 'OWN';
  @ApiProperty() restrictedToLocations!: boolean;
  @ApiProperty({ type: FollowUpReportFiltersDto })
  filters!: FollowUpReportFiltersDto;
  @ApiProperty({
    type: [FollowUpStepStatsDto],
    description: 'Pasos 1, 2 y 3, siempre los tres',
  })
  steps!: FollowUpStepStatsDto[];
  @ApiProperty({ type: FollowUpStepStatsDto }) total!: FollowUpStepStatsDto;
  @ApiProperty({
    type: [FollowUpSkipCountDto],
    description: 'Omitidos por motivo, de más a menos',
  })
  skipped!: FollowUpSkipCountDto[];
  @ApiProperty({ type: [FollowUpReportDefinitionDto] })
  definitions!: FollowUpReportDefinitionDto[];
  @ApiProperty({ type: FollowUpReportOptionsDto })
  options!: FollowUpReportOptionsDto;
}

export { SKIP_REASONS, SKIP_REASON_PROPERTY };
