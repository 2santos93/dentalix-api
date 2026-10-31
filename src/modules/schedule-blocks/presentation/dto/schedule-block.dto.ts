import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AppointmentStatus, ScheduleBlockKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { BLOCK_NOTE_MAX_LENGTH } from '../../domain/schedule-block-rules';
import { MAX_RESERVED_TYPES } from '../../domain/reserved-slot';

const KIND_DESCRIPTION =
  'VACATION (vacaciones), MEETING (reunión o congreso), LUNCH (almuerzo), OTHER, RESERVED (DX-446: hueco reservado para `reservedForTypeIds`; exige sede).';
const RESERVED_TYPES_DESCRIPTION = `DX-446: tipos de cita que SÍ se pueden agendar en un bloque RESERVED (1–${MAX_RESERVED_TYPES}, de esta clínica y activos: 404 si alguno es ajeno, 400 si está desactivado). Vacío o ausente en los demás tipos.`;
const RELEASE_DESCRIPTION =
  'DX-446: «Liberar a partir de», minutos desde las 00:00 de la hora de la SEDE del día del bloque (0–1439; 660 = 11:00), antes de su inicio. Pasada esa hora (reloj del servidor) el hueco admite cualquier tipo. null = no se libera. Solo en RESERVED.';

/** DX-446: un tipo de cita reservado, como lo pinta la agenda. */
export class ReservedTypeRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ pattern: '^#[0-9A-F]{6}$' })
  color!: string;

  @ApiProperty()
  isUrgent!: boolean;

  @ApiProperty()
  active!: boolean;
}

/** Respuesta de los endpoints de bloqueos (DX-122). */
export class ScheduleBlockDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Sede. null = el profesional en todas las sedes (solo con `providerId`).',
  })
  locationId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Profesional. null = toda la sede.',
  })
  providerId!: string | null;

  @ApiProperty({ format: 'date-time', description: 'Inicio (incluido).' })
  start!: Date;

  @ApiProperty({ format: 'date-time', description: 'Fin (excluido).' })
  end!: Date;

  @ApiProperty({
    enum: ScheduleBlockKind,
    enumName: 'ScheduleBlockKind',
    description: KIND_DESCRIPTION,
  })
  kind!: ScheduleBlockKind;

  @ApiProperty({
    description:
      'true: se puede agendar encima y la respuesta de la cita trae un aviso; false: 409.',
  })
  allowsBooking!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: BLOCK_NOTE_MAX_LENGTH,
  })
  note!: string | null;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: RESERVED_TYPES_DESCRIPTION,
  })
  reservedForTypeIds!: string[];

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 1439,
    description: RELEASE_DESCRIPTION,
  })
  releaseAtMinute!: number | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

/** DX-446: un bloque del listado de la agenda (con lo que pinta un reservado). */
export class ScheduleBlockListItemDto extends ScheduleBlockDto {
  @ApiProperty({
    type: [ReservedTypeRefDto],
    description:
      'DX-446: nombre y color de los tipos de `reservedForTypeIds` (vivos de esta clínica).',
  })
  reservedForTypes!: ReservedTypeRefDto[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'DX-446: instante de liberación del día del bloque (hora de la sede), o null.',
  })
  releaseAt!: Date | null;

  @ApiProperty({
    description:
      'DX-446: true si ya pasó `releaseAt` según el reloj del servidor: la agenda muestra «Libre desde HH:MM».',
  })
  released!: boolean;
}

export class CreateScheduleBlockDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Profesional del personal de la clínica. Sin él, el bloqueo es de toda la sede (exige `locationId`). Un odontólogo solo puede indicarse a sí mismo.',
  })
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sede de la clínica. Con `providerId` y sin sede, el bloqueo vale en todas las sedes.',
  })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  start!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Posterior a `start`; como mucho 366 días después.',
  })
  @IsDateString()
  end!: string;

  @ApiProperty({
    enum: ScheduleBlockKind,
    enumName: 'ScheduleBlockKind',
    description: KIND_DESCRIPTION,
  })
  @IsEnum(ScheduleBlockKind)
  kind!: ScheduleBlockKind;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  allowsBooking?: boolean;

  @ApiPropertyOptional({ maxLength: BLOCK_NOTE_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(BLOCK_NOTE_MAX_LENGTH)
  note?: string;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: MAX_RESERVED_TYPES,
    description: RESERVED_TYPES_DESCRIPTION,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RESERVED_TYPES)
  @IsUUID('all', { each: true })
  reservedForTypeIds?: string[];

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 1439,
    description: RELEASE_DESCRIPTION,
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(1439)
  releaseAtMinute?: number | null;

  @ApiPropertyOptional({
    description:
      'Si hay citas dentro del rango la API responde 409 (no las toca). Con true, se crea igualmente.',
  })
  @IsOptional()
  @IsBoolean()
  confirmAffected?: boolean;
}

export class UpdateScheduleBlockDto {
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsDateString()
  start?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsDateString()
  end?: string;

  @ApiPropertyOptional({
    enum: ScheduleBlockKind,
    enumName: 'ScheduleBlockKind',
  })
  @IsOptional()
  @IsEnum(ScheduleBlockKind)
  kind?: ScheduleBlockKind;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowsBooking?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: BLOCK_NOTE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(BLOCK_NOTE_MAX_LENGTH)
  note?: string | null;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: MAX_RESERVED_TYPES,
    description: RESERVED_TYPES_DESCRIPTION,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RESERVED_TYPES)
  @IsUUID('all', { each: true })
  reservedForTypeIds?: string[];

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 1439,
    description: RELEASE_DESCRIPTION,
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(1439)
  releaseAtMinute?: number | null;

  @ApiPropertyOptional({
    description: 'Igual que al crear, si el rango cambia.',
  })
  @IsOptional()
  @IsBoolean()
  confirmAffected?: boolean;
}

/** `?providerIds=a&providerIds=b` llega como array; `?providerIds=a`, como string. */
function toArray({ value }: { value: unknown }): unknown {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

export class ListScheduleBlocksQueryDto {
  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  from!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Como mucho 92 días después de `from`.',
  })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Sede. Si falta, la del request (X-Location-Id) o todas.',
  })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ type: [String], format: 'uuid', maxItems: 12 })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12, {
    message: 'Puedes ver como mucho 12 profesionales a la vez',
  })
  @IsUUID('all', { each: true })
  providerIds?: string[];
}

export class AffectedAppointmentsQueryDto {
  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  start!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  end!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  locationId?: string;
}

/** Cita viva dentro del rango de un bloqueo (para confirmar antes de crearlo). */
export class AffectedAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty({ format: 'date-time' })
  start!: Date;

  @ApiProperty({ format: 'date-time' })
  end!: Date;

  @ApiProperty({ enum: AppointmentStatus })
  status!: AppointmentStatus;

  @ApiProperty({ type: String, nullable: true })
  patientFirstName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  patientLastName!: string | null;
}

/** Citas afectadas por un bloqueo: las primeras 50 y cuántas hay en total. */
export class AffectedAppointmentsPageDto {
  @ApiProperty({ type: [AffectedAppointmentDto] })
  items!: AffectedAppointmentDto[];

  @ApiProperty({
    description: 'Total de citas afectadas (puede ser mayor que items).',
  })
  total!: number;
}
