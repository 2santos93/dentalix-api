import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { DentitionEventReason, DentitionType } from '@prisma/client';
import { PERMANENT_POSITION_PATTERN } from '../../domain/dentition';
import { MAX_DENTITION_POSITIONS } from '../../application/use-cases/dentition.use-cases';

const POSITIONS_MESSAGE =
  'Cada posición es un código FDI permanente (11-18, 21-28, 31-38, 41-48)';

export class RecordDentitionEventsDto {
  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: MAX_DENTITION_POSITIONS,
    example: ['15'],
    description:
      'Posiciones por su código FDI PERMANENTE (el 55 ocupa la posición 15)',
  })
  @IsArray({ message: 'Indica al menos una posición' })
  @ArrayMinSize(1, { message: 'Indica al menos una posición' })
  @ArrayMaxSize(MAX_DENTITION_POSITIONS, {
    message: `Como mucho ${MAX_DENTITION_POSITIONS} posiciones`,
  })
  @ArrayUnique({ message: 'Hay posiciones repetidas' })
  @IsString({ each: true, message: POSITIONS_MESSAGE })
  @Matches(PERMANENT_POSITION_PATTERN, {
    each: true,
    message: POSITIONS_MESSAGE,
  })
  positions!: string[];

  @ApiProperty({ enum: DentitionType })
  @IsEnum(DentitionType, {
    message: 'La dentición debe ser PERMANENT, PRIMARY o MIXED',
  })
  dentition!: DentitionType;

  @ApiProperty({ enum: DentitionEventReason })
  @IsEnum(DentitionEventReason, {
    message: 'El motivo debe ser MANUAL, ERUPTION o EXFOLIATION',
  })
  reason!: DentitionEventReason;
}

export class AsOfQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-01',
    description:
      'DX-120: la carta tal como estaba al final de ese día (zona de la sede). Solo lectura.',
  })
  @IsOptional()
  @IsString()
  asOf?: string;
}

export class DentitionEventDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '15' })
  position!: string;

  @ApiProperty({ enum: DentitionType })
  dentition!: DentitionType;

  @ApiProperty({ enum: DentitionEventReason })
  reason!: DentitionEventReason;

  @ApiProperty({ format: 'date-time' })
  recordedAt!: Date;

  @ApiProperty({ format: 'uuid' })
  performedById!: string;
}

export class PositionDentitionDto {
  @ApiProperty({ example: '15', description: 'Código FDI permanente' })
  position!: string;

  @ApiProperty({ enum: DentitionType })
  dentition!: DentitionType;

  @ApiProperty({
    enum: ['EVENT', 'AGE', 'DEFAULT'],
    description:
      'EVENT: último cambio registrado; AGE: por la edad; DEFAULT: sin fecha de nacimiento (permanente)',
  })
  source!: 'EVENT' | 'AGE' | 'DEFAULT';

  @ApiProperty({ type: DentitionEventDto, nullable: true })
  lastEvent!: DentitionEventDto | null;
}

export class DentitionDto {
  @ApiProperty({ enum: ['AGE', 'DEFAULT'] })
  basis!: 'AGE' | 'DEFAULT';

  @ApiProperty({ type: Number, nullable: true })
  ageYears!: number | null;

  @ApiProperty({ enum: DentitionType, description: 'Resumen de la carta' })
  overall!: DentitionType;

  @ApiProperty({ type: String, nullable: true, example: '2026-10-01' })
  asOf!: string | null;

  @ApiProperty({ type: [PositionDentitionDto] })
  positions!: PositionDentitionDto[];
}
