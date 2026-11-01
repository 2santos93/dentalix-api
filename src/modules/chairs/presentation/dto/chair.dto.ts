import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
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
  MaxLength,
  Min,
} from 'class-validator';
import { CHAIR_NAME_MAX, CHAIR_SORT_ORDER_MAX } from '../../domain/chair-rules';

const SORT_MESSAGE = `El orden del sillón debe ser un número entero entre 0 y ${CHAIR_SORT_ORDER_MAX}`;
const NAME_MESSAGE = `El nombre del sillón no puede tener más de ${CHAIR_NAME_MAX} caracteres`;
/** Tope de sillones por petición de orden (holgado: una sede tiene pocos). */
const MAX_ORDER_IDS = 200;

/** Respuesta de los endpoints de sillones (DX-211). */
export class ChairDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ minLength: 1, maxLength: CHAIR_NAME_MAX, example: 'Sillón 1' })
  name!: string;

  @ApiProperty({
    minimum: 0,
    maximum: CHAIR_SORT_ORDER_MAX,
    description: 'Orden de la columna en la agenda; empate por nombre.',
  })
  sortOrder!: number;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Profesional que se propone al elegir el sillón en una cita (solo si aún no hay profesional elegido).',
  })
  defaultProviderId!: string | null;

  @ApiProperty({
    description:
      'false = desactivado: no se ofrece para citas nuevas ni sale como columna; sus citas lo conservan.',
  })
  active!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

/** Lo que una cita embebe de su sillón (DX-211). */
export class ChairSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sillón 1' })
  name!: string;

  @ApiProperty({
    description:
      'false = el sillón se desactivó después: se muestra «(inactivo)».',
  })
  active!: boolean;
}

export class ListChairsQueryDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Sede de los sillones (entre las permitidas al usuario).',
  })
  @IsUUID()
  locationId!: string;

  @ApiPropertyOptional({
    description:
      'true = también los desactivados (pantalla de gestión). Por defecto, solo los activos.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

// Sin `tenantId`: sale del contexto del request.
export class CreateChairDto {
  @ApiProperty({ format: 'uuid', description: 'Sede del sillón.' })
  @IsUUID()
  locationId!: string;

  @ApiProperty({ minLength: 1, maxLength: CHAIR_NAME_MAX, example: 'Sillón 1' })
  @IsString()
  @MaxLength(CHAIR_NAME_MAX, { message: NAME_MESSAGE })
  name!: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: CHAIR_SORT_ORDER_MAX,
    description: 'Por defecto, al final de la sede.',
  })
  @IsOptional()
  @IsInt({ message: SORT_MESSAGE })
  @Min(0, { message: SORT_MESSAGE })
  @Max(CHAIR_SORT_ORDER_MAX, { message: SORT_MESSAGE })
  sortOrder?: number;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Profesional por defecto: un miembro activo que atiende pacientes en la sede.',
  })
  @IsOptional()
  @IsUUID()
  defaultProviderId?: string | null;
}

export class UpdateChairDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: CHAIR_NAME_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(CHAIR_NAME_MAX, { message: NAME_MESSAGE })
  name?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: CHAIR_SORT_ORDER_MAX })
  @IsOptional()
  @IsInt({ message: SORT_MESSAGE })
  @Min(0, { message: SORT_MESSAGE })
  @Max(CHAIR_SORT_ORDER_MAX, { message: SORT_MESSAGE })
  sortOrder?: number;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null quita el profesional por defecto.',
  })
  @IsOptional()
  @IsUUID()
  defaultProviderId?: string | null;
}

export class ReorderChairsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  locationId!: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'TODOS los sillones de la sede (activos o no), cada uno una vez, en el orden de las columnas.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ORDER_IDS)
  @IsUUID('all', { each: true })
  chairIds!: string[];
}
