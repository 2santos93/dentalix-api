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
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { BLOCK_NOTE_MAX_LENGTH } from '../../domain/schedule-block-rules';

const KIND_DESCRIPTION =
  'VACATION (vacaciones), MEETING (reunión o congreso), LUNCH (almuerzo), OTHER.';

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

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
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
