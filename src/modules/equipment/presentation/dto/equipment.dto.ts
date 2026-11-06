import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_RISK_CLASSES,
  EQUIPMENT_STATUSES,
  MAINTENANCE_KINDS,
} from '../../domain/entities/equipment.entity';
import {
  EQUIPMENT_NAME_MAX,
  EQUIPMENT_NOTES_MAX,
  EQUIPMENT_SHORT_TEXT_MAX,
  MAINTENANCE_DESCRIPTION_MAX,
  MAINTENANCE_INTERVAL_MAX,
  MAINTENANCE_INTERVAL_MIN,
  MAINTENANCE_PARTY_MAX,
  REASON_MAX,
} from '../../domain/equipment-rules';

const MAINTENANCE_STATUSES = [
  'OVERDUE',
  'DUE_SOON',
  'UP_TO_DATE',
  'UNSCHEDULED',
] as const;
const STATUS_FILTERS = ['ACTIVE', 'RETIRED', 'ALL'] as const;

const CATEGORY_MESSAGE = 'El tipo de equipo no es válido.';
const RISK_MESSAGE = 'La clasificación de riesgo no es válida.';
const KIND_MESSAGE = 'El tipo de mantenimiento no es válido.';
const LOCATION_MESSAGE = 'La sede no es válida.';
const CHAIR_MESSAGE = 'El sillón no es válido: elige uno de la sede o ninguno.';
const DATE_MESSAGE = 'La fecha no es válida (AAAA-MM-DD).';
const TEXT_MESSAGE = 'El texto no es válido.';
const NAME_REQUIRED_MESSAGE = `Escribe el nombre del equipo (hasta ${EQUIPMENT_NAME_MAX} caracteres).`;
const INTERVAL_MESSAGE = `La periodicidad del mantenimiento va de ${MAINTENANCE_INTERVAL_MIN} a ${MAINTENANCE_INTERVAL_MAX} meses.`;
const COST_MESSAGE =
  'El costo tiene que ser mayor que 0 y con 2 decimales como mucho.';
const DATE_DOC = { format: 'date', example: '2026-11-06' } as const;
/** Holgura sobre el tope de cada texto: el caso de uso da el mensaje exacto. */
const SLACK = 64;

// ---------------------------------------------------------------------------
// Respuestas
// ---------------------------------------------------------------------------

/** Un mantenimiento de la hoja de vida (DX-542). */
export class EquipmentMaintenanceDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  equipmentId!: string;

  @ApiProperty({
    enum: MAINTENANCE_KINDS,
    enumName: 'EquipmentMaintenanceKind',
  })
  kind!: (typeof MAINTENANCE_KINDS)[number];

  @ApiProperty({ ...DATE_DOC, description: 'Día en que se hizo (de la sede).' })
  performedOn!: string;

  @ApiProperty({ type: String, nullable: true })
  technician!: string | null;

  @ApiProperty({ type: String, nullable: true })
  company!: string | null;

  @ApiProperty()
  description!: string;

  @ApiProperty({ type: Number, nullable: true, example: 120.5 })
  cost!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'ISO 4217; solo con costo.',
  })
  currency!: string | null;

  @ApiProperty({
    type: String,
    ...DATE_DOC,
    nullable: true,
    description:
      'Próximo mantenimiento que dejó fijado: el explícito o, en un preventivo, la fecha + la periodicidad del equipo.',
  })
  nextDueOn!: string | null;

  @ApiProperty({ format: 'uuid', description: 'Quién lo registró.' })
  createdById!: string;

  @ApiProperty({ type: String, nullable: true })
  createdByName!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  voidedAt!: Date | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  voidedById!: string | null;

  @ApiProperty({ type: String, nullable: true })
  voidReason!: string | null;
}

/** Un equipo biomédico de una sede (DX-542). */
export class EquipmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty()
  locationName!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  chairId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  chairName!: string | null;

  @ApiProperty({ maxLength: EQUIPMENT_NAME_MAX, example: 'Autoclave sala 1' })
  name!: string;

  @ApiProperty({ enum: EQUIPMENT_CATEGORIES, enumName: 'EquipmentCategory' })
  category!: (typeof EQUIPMENT_CATEGORIES)[number];

  @ApiProperty({ type: String, nullable: true })
  brand!: string | null;

  @ApiProperty({ type: String, nullable: true })
  model!: string | null;

  @ApiProperty({ type: String, nullable: true })
  serialNumber!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Registro sanitario del producto (texto libre).',
  })
  sanitaryRegistration!: string | null;

  @ApiProperty({
    enum: EQUIPMENT_RISK_CLASSES,
    enumName: 'EquipmentRiskClass',
    nullable: true,
  })
  riskClass!: (typeof EQUIPMENT_RISK_CLASSES)[number] | null;

  @ApiProperty({ type: String, ...DATE_DOC, nullable: true })
  acquiredOn!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: MAINTENANCE_INTERVAL_MIN,
    maximum: MAINTENANCE_INTERVAL_MAX,
    description: 'Periodicidad del mantenimiento preventivo en meses.',
  })
  maintenanceIntervalMonths!: number | null;

  @ApiProperty({ enum: EQUIPMENT_STATUSES, enumName: 'EquipmentStatus' })
  status!: (typeof EQUIPMENT_STATUSES)[number];

  @ApiProperty({ type: String, ...DATE_DOC, nullable: true })
  retiredOn!: string | null;

  @ApiProperty({ type: String, nullable: true })
  retiredReason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({
    type: String,
    ...DATE_DOC,
    nullable: true,
    description: 'Último mantenimiento vivo (de cualquier tipo).',
  })
  lastMaintenanceOn!: string | null;

  @ApiProperty({
    type: String,
    ...DATE_DOC,
    nullable: true,
    description:
      'Próximo preventivo: el que fijó el último preventivo vivo (o su fecha + la periodicidad); sin preventivos, la adquisición + la periodicidad. null = sin programar.',
  })
  nextMaintenanceOn!: string | null;

  @ApiProperty({
    enum: MAINTENANCE_STATUSES,
    enumName: 'EquipmentMaintenanceStatus',
    nullable: true,
    description:
      'En el día de la sede: OVERDUE (antes de hoy), DUE_SOON (hoy a +30 días), UP_TO_DATE o UNSCHEDULED. null si está dado de baja.',
  })
  maintenanceStatus!: (typeof MAINTENANCE_STATUSES)[number] | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

/** La hoja de vida: el equipo y sus mantenimientos en orden cronológico. */
export class EquipmentDetailDto extends EquipmentDto {
  @ApiProperty({
    type: [EquipmentMaintenanceDto],
    description:
      'Todos sus mantenimientos (también los anulados), del más antiguo al más reciente.',
  })
  maintenances!: EquipmentMaintenanceDto[];
}

export class ListEquipmentResponseDto {
  @ApiProperty({ type: [EquipmentDto] })
  items!: EquipmentDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}

// ---------------------------------------------------------------------------
// Peticiones
// ---------------------------------------------------------------------------

export class ListEquipmentQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Una sede. Sin ella: la de la cabecera X-Location-Id o todas las permitidas.',
  })
  @IsOptional()
  @IsUUID('all', { message: LOCATION_MESSAGE })
  locationId?: string;

  @ApiPropertyOptional({ enum: STATUS_FILTERS, default: 'ACTIVE' })
  @IsOptional()
  @IsIn(STATUS_FILTERS, { message: 'El estado no es válido.' })
  status?: (typeof STATUS_FILTERS)[number];

  @ApiPropertyOptional({
    description:
      'Contenido en el nombre, la marca, el modelo o el nº de serie.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(EQUIPMENT_NAME_MAX)
  query?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'La página no es válida.' })
  @Min(1, { message: 'La página no es válida.' })
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El tamaño de página no es válido.' })
  @Min(1, { message: 'El tamaño de página no es válido.' })
  @Max(100, { message: 'El tamaño de página no es válido.' })
  pageSize?: number;
}

/** Campos editables de un equipo (todos opcionales en la edición). */
class EquipmentFieldsDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Sillón de la MISMA sede (activo); null = ninguno.',
  })
  @IsOptional()
  @IsUUID('all', { message: CHAIR_MESSAGE })
  chairId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: EQUIPMENT_SHORT_TEXT_MAX,
  })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(EQUIPMENT_SHORT_TEXT_MAX + SLACK)
  brand?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: EQUIPMENT_SHORT_TEXT_MAX,
  })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(EQUIPMENT_SHORT_TEXT_MAX + SLACK)
  model?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: EQUIPMENT_SHORT_TEXT_MAX,
  })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(EQUIPMENT_SHORT_TEXT_MAX + SLACK)
  serialNumber?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: EQUIPMENT_SHORT_TEXT_MAX,
    description: 'Registro sanitario del producto (texto libre).',
  })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(EQUIPMENT_SHORT_TEXT_MAX + SLACK)
  sanitaryRegistration?: string | null;

  @ApiPropertyOptional({
    enum: EQUIPMENT_RISK_CLASSES,
    enumName: 'EquipmentRiskClass',
    nullable: true,
  })
  @IsOptional()
  @IsIn(EQUIPMENT_RISK_CLASSES, { message: RISK_MESSAGE })
  riskClass?: (typeof EQUIPMENT_RISK_CLASSES)[number] | null;

  @ApiPropertyOptional({
    type: String,
    ...DATE_DOC,
    nullable: true,
    description: 'No futura en la sede.',
  })
  @IsOptional()
  @IsString({ message: DATE_MESSAGE })
  acquiredOn?: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: MAINTENANCE_INTERVAL_MIN,
    maximum: MAINTENANCE_INTERVAL_MAX,
    description: 'Periodicidad del preventivo en meses; null = sin programa.',
  })
  @IsOptional()
  @IsInt({ message: INTERVAL_MESSAGE })
  @Min(MAINTENANCE_INTERVAL_MIN, { message: INTERVAL_MESSAGE })
  @Max(MAINTENANCE_INTERVAL_MAX, { message: INTERVAL_MESSAGE })
  maintenanceIntervalMonths?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: EQUIPMENT_NOTES_MAX,
  })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(EQUIPMENT_NOTES_MAX + SLACK)
  notes?: string | null;
}

// Sin `tenantId`: sale del contexto del request.
export class CreateEquipmentDto extends EquipmentFieldsDto {
  @ApiProperty({ format: 'uuid', description: 'Sede del equipo.' })
  @IsUUID('all', { message: LOCATION_MESSAGE })
  locationId!: string;

  @ApiProperty({ maxLength: EQUIPMENT_NAME_MAX, example: 'Autoclave sala 1' })
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(EQUIPMENT_NAME_MAX + SLACK)
  name!: string;

  @ApiProperty({ enum: EQUIPMENT_CATEGORIES, enumName: 'EquipmentCategory' })
  @IsIn(EQUIPMENT_CATEGORIES, { message: CATEGORY_MESSAGE })
  category!: (typeof EQUIPMENT_CATEGORIES)[number];
}

/**
 * Un obligatorio que LLEGA no puede ser `null` (borrarlo): `ValidateIf` en vez
 * de `IsOptional`, que dejaría pasar el `null` hasta la BD (500).
 */
const present = (_: object, value: unknown) => value !== undefined;

export class UpdateEquipmentDto extends EquipmentFieldsDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Trasladar a otra sede: quita el sillón, salvo que venga uno de la sede nueva. No admite null.',
  })
  @ValidateIf(present)
  @IsUUID('all', { message: LOCATION_MESSAGE })
  locationId?: string;

  @ApiPropertyOptional({
    maxLength: EQUIPMENT_NAME_MAX,
    description: 'No admite null ni vacío.',
  })
  @ValidateIf(present)
  @IsString({ message: NAME_REQUIRED_MESSAGE })
  @IsNotEmpty({ message: NAME_REQUIRED_MESSAGE })
  @MaxLength(EQUIPMENT_NAME_MAX + SLACK, { message: NAME_REQUIRED_MESSAGE })
  name?: string;

  @ApiPropertyOptional({
    enum: EQUIPMENT_CATEGORIES,
    enumName: 'EquipmentCategory',
    description: 'No admite null.',
  })
  @ValidateIf(present)
  @IsIn(EQUIPMENT_CATEGORIES, { message: CATEGORY_MESSAGE })
  category?: (typeof EQUIPMENT_CATEGORIES)[number];
}

export class RetireEquipmentDto {
  @ApiPropertyOptional({
    type: String,
    ...DATE_DOC,
    description:
      'Día de la baja; por defecto hoy en la sede. No futura ni anterior a la adquisición.',
  })
  @IsOptional()
  @IsString({ message: DATE_MESSAGE })
  retiredOn?: string;

  @ApiProperty({ minLength: 3, maxLength: REASON_MAX })
  @IsString({
    message: 'Escribe el motivo de la baja (de 3 a 500 caracteres).',
  })
  @MaxLength(REASON_MAX + SLACK)
  reason!: string;
}

export class RecordMaintenanceDto {
  @ApiProperty({
    enum: MAINTENANCE_KINDS,
    enumName: 'EquipmentMaintenanceKind',
  })
  @IsIn(MAINTENANCE_KINDS, { message: KIND_MESSAGE })
  kind!: (typeof MAINTENANCE_KINDS)[number];

  @ApiProperty({ ...DATE_DOC, description: 'No futura en la sede.' })
  @IsString({ message: DATE_MESSAGE })
  performedOn!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MAINTENANCE_PARTY_MAX,
  })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(MAINTENANCE_PARTY_MAX + SLACK)
  technician?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MAINTENANCE_PARTY_MAX,
  })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(MAINTENANCE_PARTY_MAX + SLACK)
  company?: string | null;

  @ApiProperty({ maxLength: MAINTENANCE_DESCRIPTION_MAX })
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(MAINTENANCE_DESCRIPTION_MAX + SLACK)
  description!: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Mayor que 0, 2 decimales como mucho; siempre con `currency`.',
  })
  @IsOptional()
  @IsNumber({}, { message: COST_MESSAGE })
  cost?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'ISO 4217 de 3 letras; solo con costo.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsString({
    message: 'La moneda no es válida (código ISO 4217 de 3 letras).',
  })
  currency?: string | null;

  @ApiPropertyOptional({
    type: String,
    ...DATE_DOC,
    nullable: true,
    description:
      'Próximo mantenimiento explícito (posterior a la fecha). Sin él, un preventivo suma la periodicidad del equipo.',
  })
  @IsOptional()
  @IsString({ message: DATE_MESSAGE })
  nextDueOn?: string | null;
}

export class VoidMaintenanceDto {
  @ApiProperty({ minLength: 3, maxLength: REASON_MAX })
  @IsString({
    message: 'Escribe el motivo de la anulación (de 3 a 500 caracteres).',
  })
  @MaxLength(REASON_MAX + SLACK)
  reason!: string;
}
