import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  OrthoAlignerArch,
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
  IsNumber,
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
import {
  ORTHO_BRAND_MAX,
  ORTHO_DAYS_PER_TRAY_MAX,
  ORTHO_DAYS_PER_TRAY_MIN,
  ORTHO_FEE_PART_MAX,
  ORTHO_FEE_TOTAL_MAX,
  ORTHO_FEE_VISITS_MAX,
  ORTHO_OVERDUE_DAYS_DEFAULT,
  ORTHO_OVERDUE_DAYS_MAX,
  ORTHO_OVERDUE_DAYS_MIN,
  ORTHO_TRAYS_MAX,
} from '../../domain/ortho-billing';

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

  @ApiProperty({
    minimum: ORTHO_OVERDUE_DAYS_MIN,
    maximum: ORTHO_OVERDUE_DAYS_MAX,
    example: ORTHO_OVERDUE_DAYS_DEFAULT,
    description:
      'DX-285: días tras los que un cargo de ortodoncia realizado y sin pagar marca «Ortodoncia: saldo vencido»',
  })
  overdueDays!: number;
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

  @ApiPropertyOptional({
    minimum: ORTHO_OVERDUE_DAYS_MIN,
    maximum: ORTHO_OVERDUE_DAYS_MAX,
    example: ORTHO_OVERDUE_DAYS_DEFAULT,
  })
  @IsOptional()
  @IsInt({
    message: `El umbral del saldo vencido es un número entero de días de ${ORTHO_OVERDUE_DAYS_MIN} a ${ORTHO_OVERDUE_DAYS_MAX}`,
  })
  overdueDays?: number;
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

/** DX-285: honorario del caso y su reparto, en `currency`. */
export class OrthoFeeDto {
  @ApiProperty({
    description: 'Código ISO 4217: la del plan ligado o la de la sede',
  })
  currency!: string;
  @ApiProperty({ example: 3000 }) total!: number;
  @ApiProperty({ example: 600 }) initial!: number;
  @ApiProperty({ example: 90 }) perVisit!: number;
  @ApiProperty({ example: 24, description: 'Controles que se cobran' })
  visitCount!: number;
  @ApiProperty({ example: 240 }) retention!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  updatedAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  updatedById!: string | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Aceptado: sus cargos ya están en el plan y no cambia',
  })
  acceptedAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  acceptedById!: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Cuotas ACTIVE que ya tenía el plan al aceptar: no se crearon cargos, solo se informan',
  })
  paymentPlanId!: string | null;
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
  @ApiProperty({ type: OrthoFeeDto, nullable: true })
  fee!: OrthoFeeDto | null;
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

// ---------------------------------------------------------------------------
// DX-285: honorario y cuenta del caso
// ---------------------------------------------------------------------------

const AMOUNT = { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 };

export class SetOrthoFeeDto {
  @ApiProperty({ minimum: 0.01, maximum: ORTHO_FEE_TOTAL_MAX, example: 3000 })
  @Type(() => Number)
  @IsNumber(AMOUNT, {
    message: 'El honorario total debe ser un importe con hasta 2 decimales',
  })
  @Max(ORTHO_FEE_TOTAL_MAX, { message: 'El honorario total es demasiado alto' })
  total!: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: ORTHO_FEE_PART_MAX,
    example: 600,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(AMOUNT, {
    message: 'La cuota inicial debe ser un importe con hasta 2 decimales',
  })
  @Min(0, { message: 'La cuota inicial no puede ser negativa' })
  @Max(ORTHO_FEE_PART_MAX, { message: 'La cuota inicial es demasiado alta' })
  initial?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: ORTHO_FEE_PART_MAX, example: 90 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(AMOUNT, {
    message: 'El importe por control debe ser un importe con hasta 2 decimales',
  })
  @Min(0, { message: 'El importe por control no puede ser negativo' })
  @Max(ORTHO_FEE_PART_MAX, {
    message: 'El importe por control es demasiado alto',
  })
  perVisit?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: ORTHO_FEE_VISITS_MAX,
    example: 24,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Los controles que se cobran deben ser un número entero' })
  @Min(0, { message: 'Los controles que se cobran no pueden ser negativos' })
  @Max(ORTHO_FEE_VISITS_MAX, {
    message: `Como mucho se cobran ${ORTHO_FEE_VISITS_MAX} controles`,
  })
  visitCount?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: ORTHO_FEE_PART_MAX,
    example: 240,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(AMOUNT, {
    message: 'El retiro debe ser un importe con hasta 2 decimales',
  })
  @Min(0, { message: 'El retiro no puede ser negativo' })
  @Max(ORTHO_FEE_PART_MAX, { message: 'El retiro es demasiado alto' })
  retention?: number;
}

export class OrthoAccountPaymentPlanDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() status!: string;
  @ApiProperty() installmentsCount!: number;
  @ApiProperty() totalToFinance!: number;
  @ApiProperty() currency!: string;
}

export class OrthoCaseAccountDto {
  @ApiProperty({ format: 'uuid' }) caseId!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ format: 'uuid', description: 'Sede del caso' })
  locationId!: string;
  @ApiProperty({ enum: OrthoCaseStatus }) status!: OrthoCaseStatus;
  @ApiProperty({ format: 'date' }) startDate!: string;
  @ApiProperty() plannedVisits!: number;
  @ApiProperty() visitsDone!: number;
  @ApiProperty({
    enum: ['NONE', 'PENDING', 'PLAN_ITEMS', 'PAYMENT_PLAN'],
    description:
      'NONE: sin honorario. PENDING: honorario sin aceptar. PLAN_ITEMS: sus cargos están en el plan. PAYMENT_PLAN: el plan ya tenía cuotas; solo se informa',
  })
  billing!: 'NONE' | 'PENDING' | 'PLAN_ITEMS' | 'PAYMENT_PLAN';
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'La del honorario; sin honorario, la que tomaría (la del plan ligado o la de la sede); null si la sede no tiene moneda',
  })
  currency!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  treatmentPlanId!: string | null;
  @ApiProperty({ type: OrthoFeeDto, nullable: true }) fee!: OrthoFeeDto | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Realizado hasta hoy (cargos hechos)',
  })
  billed!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Lo imputado (DX-051) a los cargos del caso',
  })
  paid!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Realizado − pagado (negativo = pagado por adelantado)',
  })
  balance!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Lo que falta por realizar del honorario',
  })
  remaining!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Lo realizado y sin pagar de hace más de `overdueDays` días',
  })
  overdue!: number | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  overdueSince!: string | null;
  @ApiProperty() overdueAgeDays!: number;
  @ApiProperty() hasOverdue!: boolean;
  @ApiProperty({ description: 'Umbral de la clínica' }) overdueDays!: number;
  @ApiProperty() visitsCharged!: number;
  @ApiProperty({
    description: 'Cargos cuyo ítem se retiró del plan (no cuentan)',
  })
  removedCharges!: number;
  @ApiProperty({ type: OrthoAccountPaymentPlanDto, nullable: true })
  paymentPlan!: OrthoAccountPaymentPlanDto | null;
}

/** «Ortodoncia: saldo vencido» del paciente de una cita (sin importe). */
export class OrthoBalanceFlagDto {
  @ApiProperty() hasOverdue!: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Días del cargo vencido más antiguo',
  })
  overdueDays!: number | null;
}

// ---------------------------------------------------------------------------
// DX-285: alineadores
// ---------------------------------------------------------------------------

export class CreateOrthoAlignerSeriesDto {
  @ApiProperty({ enum: OrthoAlignerArch })
  @IsEnum(OrthoAlignerArch, {
    message: 'La arcada es superior, inferior o ambas',
  })
  arch!: OrthoAlignerArch;

  @ApiProperty({ maxLength: ORTHO_BRAND_MAX, example: 'Marca del fabricante' })
  @IsString({ message: 'La marca debe ser un texto' })
  @TextMaxLength(ORTHO_BRAND_MAX * 2)
  brand!: string;

  @ApiProperty({ minimum: 1, maximum: ORTHO_TRAYS_MAX, example: 20 })
  @Type(() => Number)
  @IsInt({ message: 'El número de bandejas debe ser un número entero' })
  totalTrays!: number;

  @ApiProperty({
    minimum: ORTHO_DAYS_PER_TRAY_MIN,
    maximum: ORTHO_DAYS_PER_TRAY_MAX,
    example: 14,
  })
  @Type(() => Number)
  @IsInt({ message: 'Los días por bandeja deben ser un número entero' })
  daysPerTray!: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Refinamiento: la serie (de este caso) que continúa',
  })
  @IsOptional()
  @IsUUID('4', { message: 'La serie que se refina no es válida' })
  refinementOfId?: string;
}

export class AddOrthoAlignerDeliveryDto {
  @ApiProperty({ minimum: 1, maximum: ORTHO_TRAYS_MAX, example: 5 })
  @Type(() => Number)
  @IsInt({ message: 'La primera bandeja debe ser un número entero' })
  fromTray!: number;

  @ApiProperty({ minimum: 1, maximum: ORTHO_TRAYS_MAX, example: 8 })
  @Type(() => Number)
  @IsInt({ message: 'La última bandeja debe ser un número entero' })
  toTray!: number;

  @ApiPropertyOptional({
    format: 'date',
    example: DATE_EXAMPLE,
    description: 'Sin ella: el día del control (`visitId`) o hoy en la sede',
  })
  @IsOptional()
  @IsString({ message: 'La fecha de la entrega debe ser una fecha AAAA-MM-DD' })
  @TextMaxLength(INPUT_CODE_MAX)
  deliveredOn?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'El control (de este caso) en el que se entregó',
  })
  @IsOptional()
  @IsUUID('4', { message: 'El control no es válido' })
  visitId?: string;
}

export class OrthoAlignerDeliveryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fromTray!: number;
  @ApiProperty() toTray!: number;
  @ApiProperty({ format: 'date' }) deliveredOn!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  visitId!: string | null;
  @ApiProperty({ format: 'uuid' }) createdById!: string;
  @ApiProperty({ type: String, nullable: true }) createdByName!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class OrthoAlignerSeriesDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) caseId!: string;
  @ApiProperty({ enum: OrthoAlignerArch }) arch!: OrthoAlignerArch;
  @ApiProperty() brand!: string;
  @ApiProperty() totalTrays!: number;
  @ApiProperty() daysPerTray!: number;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  refinementOfId!: string | null;
  @ApiProperty({ description: '1 = la serie inicial; 2… los refinamientos' })
  sequence!: number;
  @ApiProperty({ format: 'uuid' }) createdById!: string;
  @ApiProperty({ type: String, nullable: true }) createdByName!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: [OrthoAlignerDeliveryDto] })
  deliveries!: OrthoAlignerDeliveryDto[];
  @ApiProperty({
    enum: ['NOT_STARTED', 'IN_PROGRESS', 'NEEDS_DELIVERY', 'FINISHED'],
    description:
      'NEEDS_DELIVERY = ya tocaba la siguiente bandeja y no está entregada («Sin bandejas: entregar»)',
  })
  state!: 'NOT_STARTED' | 'IN_PROGRESS' | 'NEEDS_DELIVERY' | 'FINISHED';
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'La de hoy; nunca más allá de la última entregada',
  })
  currentTray!: number | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  currentTrayStartedOn!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  nextChangeOn!: string | null;
  @ApiProperty() lastDeliveredTray!: number;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  estimatedEndOn!: string | null;
}

export class OrthoAlignersDto {
  @ApiProperty({ format: 'date', description: 'Hoy en la sede del caso' })
  today!: string;
  @ApiProperty({ type: [OrthoAlignerSeriesDto] })
  series!: OrthoAlignerSeriesDto[];
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'La serie vigente de la arcada superior',
  })
  upperSeriesId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  lowerSeriesId!: string | null;
}
