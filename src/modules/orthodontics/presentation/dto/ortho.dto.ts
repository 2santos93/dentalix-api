import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  OrthoCaseStatus,
  OrthoElasticType,
  OrthoElasticWear,
  OrthoIncident,
  OrthoTechnique,
  OrthoWireMaterial,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  INPUT_CODE_MAX,
  INPUT_NOTES_MAX,
  INPUT_REASON_MAX,
  TextMaxLength,
} from '../../../../shared/validation/input-limits';
import {
  ORTHO_GAUGES_MAX,
  ORTHO_GAUGE_MAX,
  ORTHO_INTERVAL_MAX,
  ORTHO_INTERVAL_MIN,
  ORTHO_MONTHS_MAX,
  ORTHO_MONTHS_MIN,
  ORTHO_VISITS_MAX,
  ORTHO_VISITS_MIN,
} from '../../domain/ortho-rules';

// Fechas como texto AAAA-MM-DD: las valida el dominio (un solo 400 en español
// con todos los fallos). Sin tenant, paciente, autor ni hora: los pone el
// servidor.

const DATE_EXAMPLE = '2026-11-16';

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

export class OrthoSettingsDto {
  @ApiProperty({ description: 'La clínica usa el módulo de ortodoncia' })
  enabled!: boolean;

  @ApiProperty({
    type: [String],
    example: ['0.014', '0.016', '0.016x0.022', '0.019x0.025'],
    description: 'Calibres de arco que ofrece el control (lista de la clínica)',
  })
  wireGauges!: string[];
}

export class UpdateOrthoSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean({ message: 'Indica si la clínica usa la ortodoncia (sí o no)' })
  enabled?: boolean;

  @ApiPropertyOptional({ type: [String], maxItems: ORTHO_GAUGES_MAX })
  @IsOptional()
  @IsArray({ message: 'Los calibres deben ser una lista' })
  @ArrayMaxSize(ORTHO_GAUGES_MAX, {
    message: `Indica como mucho ${ORTHO_GAUGES_MAX} calibres`,
  })
  @IsString({ each: true, message: 'Cada calibre debe ser un texto' })
  @TextMaxLength(ORTHO_GAUGE_MAX * 4, { each: true })
  wireGauges?: string[];
}

// ---------------------------------------------------------------------------
// Caso
// ---------------------------------------------------------------------------

export class CreateOrthoCaseDto {
  @ApiProperty({ enum: OrthoTechnique })
  @IsOptional()
  @IsEnum(OrthoTechnique, { message: 'La técnica no es válida' })
  technique?: OrthoTechnique;

  @ApiProperty({ format: 'date', example: DATE_EXAMPLE })
  @IsOptional()
  @IsString({ message: 'La fecha de inicio debe ser una fecha AAAA-MM-DD' })
  @TextMaxLength(INPUT_CODE_MAX)
  startDate?: string;

  @ApiProperty({
    minimum: ORTHO_MONTHS_MIN,
    maximum: ORTHO_MONTHS_MAX,
    example: 24,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'La duración estimada debe ser un número entero de meses' })
  estimatedMonths?: number;

  @ApiProperty({
    minimum: ORTHO_VISITS_MIN,
    maximum: ORTHO_VISITS_MAX,
    example: 24,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Los controles previstos deben ser un número entero' })
  plannedVisits?: number;

  @ApiPropertyOptional({
    minimum: ORTHO_INTERVAL_MIN,
    maximum: ORTHO_INTERVAL_MAX,
    default: 30,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({
    message: 'El intervalo entre controles debe ser un número entero de días',
  })
  visitIntervalDays?: number;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @IsOptional()
  @IsString({ message: 'La fecha de cementado debe ser una fecha AAAA-MM-DD' })
  @TextMaxLength(INPUT_CODE_MAX)
  bondedOn?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @IsOptional()
  @IsString({ message: 'La fecha de retiro debe ser una fecha AAAA-MM-DD' })
  @TextMaxLength(INPUT_CODE_MAX)
  debondedOn?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Profesional responsable (por defecto, quien crea el caso)',
  })
  @IsOptional()
  @IsUUID('all', { message: 'El profesional debe ser un identificador válido' })
  providerId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Sede del caso (por defecto, la sede activa)',
  })
  @IsOptional()
  @IsUUID('all', { message: 'La sede debe ser un identificador válido' })
  locationId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('all', {
    message: 'El plan de tratamiento debe ser un identificador válido',
  })
  treatmentPlanId?: string | null;
}

export class UpdateOrthoCaseDto {
  @ApiPropertyOptional({ enum: OrthoTechnique })
  @IsOptional()
  @IsEnum(OrthoTechnique, { message: 'La técnica no es válida' })
  technique?: OrthoTechnique;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @IsString({ message: 'La fecha de inicio debe ser una fecha AAAA-MM-DD' })
  @TextMaxLength(INPUT_CODE_MAX)
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'La duración estimada debe ser un número entero de meses' })
  estimatedMonths?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Los controles previstos deben ser un número entero' })
  plannedVisits?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt({
    message: 'El intervalo entre controles debe ser un número entero de días',
  })
  visitIntervalDays?: number;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @IsOptional()
  @IsString({ message: 'La fecha de cementado debe ser una fecha AAAA-MM-DD' })
  @TextMaxLength(INPUT_CODE_MAX)
  bondedOn?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @IsOptional()
  @IsString({ message: 'La fecha de retiro debe ser una fecha AAAA-MM-DD' })
  @TextMaxLength(INPUT_CODE_MAX)
  debondedOn?: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'El profesional debe ser un identificador válido' })
  providerId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('all', {
    message: 'El plan de tratamiento debe ser un identificador válido',
  })
  treatmentPlanId?: string | null;
}

export class ChangeOrthoCaseStatusDto {
  @ApiProperty({
    enum: [
      OrthoCaseStatus.RETENTION,
      OrthoCaseStatus.FINISHED,
      OrthoCaseStatus.ABANDONED,
    ],
  })
  @IsIn(
    [
      OrthoCaseStatus.RETENTION,
      OrthoCaseStatus.FINISHED,
      OrthoCaseStatus.ABANDONED,
    ],
    { message: 'El estado debe ser RETENTION, FINISHED o ABANDONED' },
  )
  status!: OrthoCaseStatus;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Motivo (obligatorio al abandonar)',
  })
  @IsOptional()
  @IsString({ message: 'El motivo debe ser un texto' })
  @TextMaxLength(INPUT_REASON_MAX)
  reason?: string;
}

export class OrthoWireDto {
  @ApiProperty({ enum: OrthoWireMaterial })
  @IsEnum(OrthoWireMaterial, { message: 'El material del arco no es válido' })
  material!: OrthoWireMaterial;

  @ApiProperty({ example: '0.016x0.022' })
  @IsString({ message: 'El calibre debe ser un texto' })
  @TextMaxLength(ORTHO_GAUGE_MAX * 4)
  gauge!: string;
}

export class OrthoProgressDto {
  @ApiProperty() visitsDone!: number;
  @ApiProperty() plannedVisits!: number;
  @ApiProperty() monthsElapsed!: number;
  @ApiProperty() estimatedMonths!: number;
  @ApiProperty({ description: '0–100' }) percent!: number;
}

export class OrthoCaseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty() locationName!: string;
  @ApiProperty({ format: 'uuid' }) providerId!: string;
  @ApiProperty({ type: String, nullable: true }) providerName!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  treatmentPlanId!: string | null;
  @ApiProperty({ enum: OrthoTechnique }) technique!: OrthoTechnique;
  @ApiProperty({ format: 'date' }) startDate!: string;
  @ApiProperty() estimatedMonths!: number;
  @ApiProperty() plannedVisits!: number;
  @ApiProperty() visitIntervalDays!: number;
  @ApiProperty({ enum: OrthoCaseStatus }) status!: OrthoCaseStatus;
  @ApiProperty({ type: String, nullable: true }) statusReason!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  statusChangedAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  statusChangedById!: string | null;
  @ApiProperty({ type: String, nullable: true })
  statusChangedByName!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  bondedOn!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  debondedOn!: string | null;
  @ApiProperty({ format: 'uuid' }) createdById!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ type: OrthoProgressDto }) progress!: OrthoProgressDto;
  @ApiProperty({ type: OrthoWireDto, nullable: true })
  currentUpperWire!: OrthoWireDto | null;
  @ApiProperty({ type: OrthoWireDto, nullable: true })
  currentLowerWire!: OrthoWireDto | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  lastVisitDate!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  nextVisitProposedOn!: string | null;
  @ApiProperty({
    description:
      'Caso activo con el último control (o el inicio) hace más de intervalo + 15 días',
  })
  overdue!: boolean;
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

export class RegisterOrthoVisitDto {
  @ApiPropertyOptional({
    format: 'date',
    description:
      'Día de la atención. Con cita, el de la cita (por defecto); sin ella, hoy.',
  })
  @IsOptional()
  @IsString({ message: 'La fecha de atención debe ser una fecha AAAA-MM-DD' })
  @TextMaxLength(INPUT_CODE_MAX)
  entryDate?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'La cita debe ser un identificador válido' })
  appointmentId?: string;

  @ApiPropertyOptional({ type: OrthoWireDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => OrthoWireDto)
  upperWire?: OrthoWireDto | null;

  @ApiPropertyOptional({ type: OrthoWireDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => OrthoWireDto)
  lowerWire?: OrthoWireDto | null;

  @ApiPropertyOptional({ enum: OrthoElasticType, nullable: true })
  @IsOptional()
  @IsEnum(OrthoElasticType, { message: 'El tipo de elásticos no es válido' })
  elasticsType?: OrthoElasticType | null;

  @ApiPropertyOptional({ enum: OrthoElasticWear, nullable: true })
  @IsOptional()
  @IsEnum(OrthoElasticWear, { message: 'El uso de los elásticos no es válido' })
  elasticsWear?: OrthoElasticWear | null;

  @ApiPropertyOptional({ type: String, maxLength: 500, nullable: true })
  @IsOptional()
  @IsString({ message: 'La aparatología debe ser un texto' })
  @TextMaxLength(INPUT_REASON_MAX)
  applianceChanges?: string | null;

  @ApiPropertyOptional({ enum: OrthoIncident, isArray: true })
  @IsOptional()
  @IsArray({ message: 'Las incidencias deben ser una lista' })
  @ArrayMaxSize(3, { message: 'Indica como mucho 3 incidencias' })
  @IsEnum(OrthoIncident, { each: true, message: 'Una incidencia no es válida' })
  incidents?: OrthoIncident[];

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 4, nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El índice de higiene va de 1 a 4' })
  @Min(1, { message: 'El índice de higiene va de 1 a 4' })
  @Max(4, { message: 'El índice de higiene va de 1 a 4' })
  hygieneIndex?: number | null;

  @ApiPropertyOptional({ type: String, maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString({ message: 'La nota debe ser un texto' })
  @TextMaxLength(INPUT_NOTES_MAX)
  note?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @IsOptional()
  @IsString({ message: 'El próximo control debe ser una fecha AAAA-MM-DD' })
  @TextMaxLength(INPUT_CODE_MAX)
  nextVisitProposedOn?: string | null;
}

export class OrthoVisitAddendumDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty() text!: string;
  @ApiProperty({ format: 'uuid' }) authorId!: string;
  @ApiProperty({ type: String, nullable: true }) authorName!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class OrthoVisitDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) caseId!: string;
  @ApiProperty({
    format: 'uuid',
    description: 'Evolución que documenta el control (las adendas van aquí)',
  })
  clinicalEntryId!: string;
  @ApiProperty() visitNumber!: number;
  @ApiProperty({ format: 'date' }) visitDate!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  appointmentId!: string | null;
  @ApiProperty({ type: OrthoWireDto, nullable: true })
  upperWire!: OrthoWireDto | null;
  @ApiProperty({ type: OrthoWireDto, nullable: true })
  lowerWire!: OrthoWireDto | null;
  @ApiProperty({ enum: OrthoElasticType, nullable: true })
  elasticsType!: OrthoElasticType | null;
  @ApiProperty({ enum: OrthoElasticWear, nullable: true })
  elasticsWear!: OrthoElasticWear | null;
  @ApiProperty({ type: String, nullable: true })
  applianceChanges!: string | null;
  @ApiProperty({ enum: OrthoIncident, isArray: true })
  incidents!: OrthoIncident[];
  @ApiProperty({ type: Number, nullable: true }) hygieneIndex!: number | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  nextVisitProposedOn!: string | null;
  @ApiProperty() notes!: string;
  @ApiProperty({ format: 'uuid' }) authorId!: string;
  @ApiProperty({ type: String, nullable: true }) authorName!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: [OrthoVisitAddendumDto] })
  addenda!: OrthoVisitAddendumDto[];
}

// ---------------------------------------------------------------------------
// Lista de la clínica
// ---------------------------------------------------------------------------

export const ORTHO_FOLLOW_UP_FILTERS = [
  'ALL',
  'OVERDUE',
  'NO_NEXT_APPOINTMENT',
] as const;

export class OrthoFollowUpQueryDto {
  @ApiPropertyOptional({ enum: ORTHO_FOLLOW_UP_FILTERS, default: 'ALL' })
  @IsOptional()
  @IsIn(ORTHO_FOLLOW_UP_FILTERS, {
    message: 'El filtro debe ser ALL, OVERDUE o NO_NEXT_APPOINTMENT',
  })
  filter?: (typeof ORTHO_FOLLOW_UP_FILTERS)[number];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'La sede debe ser un identificador válido' })
  locationId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'El profesional debe ser un identificador válido' })
  providerId?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'La página debe ser un número entero' })
  @Min(1, { message: 'La página empieza en 1' })
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El tamaño de página debe ser un número entero' })
  @Min(1, { message: 'El tamaño de página va de 1 a 100' })
  @Max(100, { message: 'El tamaño de página va de 1 a 100' })
  pageSize?: number;
}

export class OrthoFollowUpRowDto {
  @ApiProperty({ format: 'uuid' }) caseId!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty() patientFirstName!: string;
  @ApiProperty() patientLastName!: string;
  @ApiProperty({ type: String, nullable: true }) patientPhone!: string | null;
  @ApiProperty({ type: String, nullable: true })
  patientPhoneE164!: string | null;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty() locationName!: string;
  @ApiProperty({ format: 'uuid' }) providerId!: string;
  @ApiProperty({ type: String, nullable: true }) providerName!: string | null;
  @ApiProperty({ enum: OrthoTechnique }) technique!: OrthoTechnique;
  @ApiProperty({ format: 'date' }) startDate!: string;
  @ApiProperty() visitIntervalDays!: number;
  @ApiProperty() visitsDone!: number;
  @ApiProperty() plannedVisits!: number;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  lastVisitDate!: string | null;
  @ApiProperty() daysSinceLastVisit!: number;
  @ApiProperty() overdue!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  nextAppointmentAt!: Date | null;
  @ApiProperty() noNextAppointment!: boolean;
  @ApiProperty() noShowCount!: number;
}

export class OrthoFollowUpPageDto {
  @ApiProperty({ type: [OrthoFollowUpRowDto] }) items!: OrthoFollowUpRowDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}
