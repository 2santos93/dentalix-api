import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { REASON_MAX } from '../../../equipment/domain/equipment-rules';
import {
  RADIOLOGY_DUE_LIMIT_DEFAULT,
  RADIOLOGY_DUE_LIMIT_MAX,
} from '../../application/use-cases/radiology.use-cases';
import {
  RADIOLOGY_LICENSE_CATEGORIES,
  RADIOLOGY_RECORD_KINDS,
  RADIOLOGY_STATUSES,
} from '../../domain/entities/radiology-record.entity';
import { RADIOLOGY_DUE_STATUSES } from '../../domain/radiology-due';
import {
  RADIOLOGY_ISSUER_MAX,
  RADIOLOGY_NOTES_MAX,
  RADIOLOGY_OFFICER_MAX,
  RADIOLOGY_REFERENCE_MAX,
} from '../../domain/radiology-rules';

const STATUS_FILTERS = ['LIVE', 'VOIDED', 'ALL'] as const;

const KIND_MESSAGE = 'El tipo de documento no es válido.';
const CATEGORY_MESSAGE = 'La categoría de la licencia no es válida (I o II).';
const LOCATION_MESSAGE = 'La sede no es válida.';
const EQUIPMENT_MESSAGE =
  'El equipo no es válido: elige uno de rayos X de la sede o ninguno.';
const OFFICER_MESSAGE = 'El miembro del personal no es válido.';
const DATE_MESSAGE = 'La fecha no es válida (AAAA-MM-DD).';
const TEXT_MESSAGE = 'El texto no es válido.';
const ISSUER_REQUIRED_MESSAGE = 'Escribe la entidad emisora.';
const ISSUED_REQUIRED_MESSAGE =
  'La fecha de expedición no es válida (AAAA-MM-DD).';
const DATE_DOC = { format: 'date', example: '2026-11-06' } as const;
/** Holgura sobre el tope de cada texto: el caso de uso da el mensaje exacto. */
const SLACK = 64;

// ---------------------------------------------------------------------------
// Respuestas
// ---------------------------------------------------------------------------

/** Un documento del expediente de rayos X de una sede (DX-544). */
export class RadiologyRecordDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty()
  locationName!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Equipo de rayos X de la MISMA sede (DX-542); null = la sede.',
  })
  equipmentId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  equipmentName!: string | null;

  @ApiProperty({
    enum: RADIOLOGY_RECORD_KINDS,
    enumName: 'RadiologyRecordKind',
  })
  kind!: (typeof RADIOLOGY_RECORD_KINDS)[number];

  @ApiProperty({
    enum: RADIOLOGY_LICENSE_CATEGORIES,
    enumName: 'RadiologyLicenseCategory',
    nullable: true,
    description:
      'Solo en una licencia: I (periapical) o II (panorámica, tomografía).',
  })
  category!: (typeof RADIOLOGY_LICENSE_CATEGORIES)[number] | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nº de la licencia o resolución, o del informe.',
  })
  reference!: string | null;

  @ApiProperty({
    description:
      'Autoridad que expidió la licencia o empresa que hizo el control.',
  })
  issuer!: string;

  @ApiProperty({ ...DATE_DOC, description: 'Día de expedición (de la sede).' })
  issuedOn!: string;

  @ApiProperty({
    ...DATE_DOC,
    description:
      'Día de vencimiento: el escrito o, si no se escribió, expedición + 5 años (licencia I), + 4 (licencia II) o + 2 (control de calidad).',
  })
  expiresOn!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Encargado u oficial de protección radiológica del personal.',
  })
  officerUserId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Nombre del miembro del personal elegido como encargado.',
  })
  officerMemberName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Encargado escrito a mano (si no es del personal).',
  })
  officerName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({
    enum: RADIOLOGY_STATUSES,
    enumName: 'RadiologyRecordStatus',
    nullable: true,
    description:
      'En el día de la sede: OVERDUE (antes de hoy), DUE_SOON (hoy a +90 días), UP_TO_DATE, o RENEWED (otro vivo del mismo tipo, sede y equipo vence después). null si está anulado.',
  })
  status!: (typeof RADIOLOGY_STATUSES)[number] | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  voidedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  voidReason!: string | null;
}

export class ListRadiologyRecordsResponseDto {
  @ApiProperty({ type: [RadiologyRecordDto] })
  items!: RadiologyRecordDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}

/** Un aviso de «Mi día»: un documento vencido o que vence en ≤90 días. */
export class RadiologyDueItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: RADIOLOGY_RECORD_KINDS,
    enumName: 'RadiologyRecordKind',
  })
  kind!: (typeof RADIOLOGY_RECORD_KINDS)[number];

  @ApiProperty({
    enum: RADIOLOGY_LICENSE_CATEGORIES,
    enumName: 'RadiologyLicenseCategory',
    nullable: true,
  })
  category!: (typeof RADIOLOGY_LICENSE_CATEGORIES)[number] | null;

  @ApiProperty({ type: String, nullable: true })
  reference!: string | null;

  @ApiProperty()
  issuer!: string;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty()
  locationName!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  equipmentId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  equipmentName!: string | null;

  @ApiProperty({ ...DATE_DOC, description: 'Día de vencimiento en la sede.' })
  expiresOn!: string;

  @ApiProperty({
    enum: RADIOLOGY_DUE_STATUSES,
    enumName: 'RadiologyDueStatus',
    description:
      'OVERDUE: ya venció en el día de la sede. DUE_SOON: vence hoy o en los próximos 90 días.',
  })
  status!: (typeof RADIOLOGY_DUE_STATUSES)[number];

  @ApiProperty({
    type: 'integer',
    example: -12,
    description:
      'Días de la sede hasta el vencimiento: 0 = hoy, negativo = días vencido.',
  })
  daysUntilExpiry!: number;
}

export class RadiologyDueResponseDto {
  @ApiProperty({ format: 'date-time', description: 'Instante del cálculo.' })
  generatedAt!: string;

  @ApiProperty({
    type: [RadiologyDueItemDto],
    description:
      'Los primeros `limit` avisos, de lo más urgente a lo menos (vencimiento más antiguo primero; a igual fecha, sede, tipo e id).',
  })
  items!: RadiologyDueItemDto[];

  @ApiProperty({
    type: 'integer',
    description: 'Todos los avisos del alcance (vencidos + vencen pronto).',
  })
  total!: number;
}

// ---------------------------------------------------------------------------
// Peticiones
// ---------------------------------------------------------------------------

export class ListRadiologyRecordsQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Una sede. Sin ella: la de la cabecera X-Location-Id o todas las permitidas.',
  })
  @IsOptional()
  @IsUUID('all', { message: LOCATION_MESSAGE })
  locationId?: string;

  @ApiPropertyOptional({
    enum: RADIOLOGY_RECORD_KINDS,
    enumName: 'RadiologyRecordKind',
  })
  @IsOptional()
  @IsIn(RADIOLOGY_RECORD_KINDS, { message: KIND_MESSAGE })
  kind?: (typeof RADIOLOGY_RECORD_KINDS)[number];

  @ApiPropertyOptional({
    enum: STATUS_FILTERS,
    default: 'LIVE',
    description: 'LIVE = sin anular.',
  })
  @IsOptional()
  @IsIn(STATUS_FILTERS, { message: 'El estado no es válido.' })
  status?: (typeof STATUS_FILTERS)[number];

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

/** Campos editables de un documento (todos opcionales en la edición). */
class RadiologyFieldsDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Equipo de rayos X ACTIVO de la MISMA sede; null = ninguno.',
  })
  @IsOptional()
  @IsUUID('all', { message: EQUIPMENT_MESSAGE })
  equipmentId?: string | null;

  @ApiPropertyOptional({
    enum: RADIOLOGY_LICENSE_CATEGORIES,
    enumName: 'RadiologyLicenseCategory',
    nullable: true,
    description: 'Obligatoria en una licencia; no va en un control de calidad.',
  })
  @IsOptional()
  @IsIn(RADIOLOGY_LICENSE_CATEGORIES, { message: CATEGORY_MESSAGE })
  category?: (typeof RADIOLOGY_LICENSE_CATEGORIES)[number] | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: RADIOLOGY_REFERENCE_MAX,
    description: 'Nº o resolución; obligatorio en una licencia.',
  })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(RADIOLOGY_REFERENCE_MAX + SLACK)
  reference?: string | null;

  @ApiPropertyOptional({
    type: String,
    ...DATE_DOC,
    nullable: true,
    description:
      'Vencimiento del papel (posterior a la expedición, 10 años como mucho). Vacío o null: se calcula (licencia I +5 años, II +4, control +2). En la edición, sin él se recalcula solo si cambian la expedición o la categoría.',
  })
  @IsOptional()
  @IsString({ message: DATE_MESSAGE })
  expiresOn?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Encargado u oficial de protección radiológica: un miembro ACTIVO del personal (o `officerName`, no los dos).',
  })
  @IsOptional()
  @IsUUID('all', { message: OFFICER_MESSAGE })
  officerUserId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: RADIOLOGY_OFFICER_MAX,
    description: 'Encargado escrito a mano si no es del personal.',
  })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(RADIOLOGY_OFFICER_MAX + SLACK)
  officerName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: RADIOLOGY_NOTES_MAX,
  })
  @IsOptional()
  @IsString({ message: TEXT_MESSAGE })
  @MaxLength(RADIOLOGY_NOTES_MAX + SLACK)
  notes?: string | null;
}

// Sin `tenantId`: sale del contexto del request.
export class CreateRadiologyRecordDto extends RadiologyFieldsDto {
  @ApiProperty({
    enum: RADIOLOGY_RECORD_KINDS,
    enumName: 'RadiologyRecordKind',
  })
  @IsIn(RADIOLOGY_RECORD_KINDS, { message: KIND_MESSAGE })
  kind!: (typeof RADIOLOGY_RECORD_KINDS)[number];

  @ApiProperty({ format: 'uuid', description: 'Sede del documento.' })
  @IsUUID('all', { message: LOCATION_MESSAGE })
  locationId!: string;

  @ApiProperty({
    maxLength: RADIOLOGY_ISSUER_MAX,
    example: 'Autoridad sanitaria de la región',
  })
  @IsString({ message: ISSUER_REQUIRED_MESSAGE })
  @MaxLength(RADIOLOGY_ISSUER_MAX + SLACK)
  issuer!: string;

  @ApiProperty({ ...DATE_DOC, description: 'No futura en la sede.' })
  @IsString({ message: ISSUED_REQUIRED_MESSAGE })
  issuedOn!: string;
}

/**
 * Un obligatorio que LLEGA no puede ser `null` (borrarlo): `ValidateIf` en vez
 * de `IsOptional`, que dejaría pasar el `null` hasta la BD (500).
 */
const present = (_: object, value: unknown) => value !== undefined;

/** El tipo no cambia: una licencia no se convierte en un control de calidad. */
export class UpdateRadiologyRecordDto extends RadiologyFieldsDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Mover a otra sede: quita el equipo, salvo que venga uno de la sede nueva. No admite null.',
  })
  @ValidateIf(present)
  @IsUUID('all', { message: LOCATION_MESSAGE })
  locationId?: string;

  @ApiPropertyOptional({
    maxLength: RADIOLOGY_ISSUER_MAX,
    description: 'No admite null ni vacío.',
  })
  @ValidateIf(present)
  @IsString({ message: ISSUER_REQUIRED_MESSAGE })
  @IsNotEmpty({ message: ISSUER_REQUIRED_MESSAGE })
  @MaxLength(RADIOLOGY_ISSUER_MAX + SLACK)
  issuer?: string;

  @ApiPropertyOptional({
    ...DATE_DOC,
    description: 'No futura en la sede. No admite null.',
  })
  @ValidateIf(present)
  @IsString({ message: ISSUED_REQUIRED_MESSAGE })
  issuedOn?: string;
}

export class VoidRadiologyRecordDto {
  @ApiProperty({ minLength: 3, maxLength: REASON_MAX })
  @IsString({
    message: 'Escribe el motivo de la anulación (de 3 a 500 caracteres).',
  })
  @MaxLength(REASON_MAX + SLACK)
  reason!: string;
}

/** `GET /radiology-records/due`. */
export class RadiologyDueQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: RADIOLOGY_DUE_LIMIT_MAX,
    default: RADIOLOGY_DUE_LIMIT_DEFAULT,
    description: 'Cuántos avisos devolver (el total los cuenta todos).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El límite no es válido.' })
  @Min(1, { message: 'El límite no es válido.' })
  @Max(RADIOLOGY_DUE_LIMIT_MAX, { message: 'El límite no es válido.' })
  limit?: number;
}
