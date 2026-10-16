import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PerioSite } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  MAX_SITES_PER_REQUEST,
  MAX_TEETH_PER_REQUEST,
} from '../../domain/perio-measures';

const INT = { message: 'debe ser un número entero' };
const BOOL = { message: 'debe ser verdadero o falso' };

// Aquí solo se valida la FORMA. Rangos, FDI y sitio los valida el caso de uso
// (validatePerioMeasures) para que el 400 diga «Diente 16, sitio MB: …».
export class PerioSiteMeasureInputDto {
  @ApiProperty({ example: 16, description: 'Diente FDI permanente (11–48)' })
  @IsInt(INT)
  toothFdi!: number;

  @ApiProperty({ enum: PerioSite, enumName: 'PerioSite' })
  @IsString({ message: 'el sitio debe ser MB, B, DB, ML, L o DL' })
  site!: PerioSite;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 19,
  })
  @IsOptional()
  @IsInt(INT)
  probingMm?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: -5,
    maximum: 19,
    description:
      'Positivo = recesión (margen apical a la UAC); negativo = margen coronal a la UAC. NIC = sondaje + recesión.',
  })
  @IsOptional()
  @IsInt(INT)
  recessionMm?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 3 })
  @IsOptional()
  @IsInt(INT)
  furcation?: number | null;

  @ApiPropertyOptional({ description: 'Sangrado al sondaje (BOP)' })
  @IsOptional()
  @IsBoolean(BOOL)
  bleeding?: boolean;

  @ApiPropertyOptional({ description: 'Supuración' })
  @IsOptional()
  @IsBoolean(BOOL)
  suppuration?: boolean;

  @ApiPropertyOptional({ description: 'Placa' })
  @IsOptional()
  @IsBoolean(BOOL)
  plaque?: boolean;

  @ApiPropertyOptional({ description: 'Cálculo' })
  @IsOptional()
  @IsBoolean(BOOL)
  calculus?: boolean;
}

export class PerioToothMeasureInputDto {
  @ApiProperty({ example: 16 })
  @IsInt(INT)
  toothFdi!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 3 })
  @IsOptional()
  @IsInt(INT)
  mobility?: number | null;

  @ApiPropertyOptional({
    description: 'Diente omitido (ausente / no sondable)',
  })
  @IsOptional()
  @IsBoolean(BOOL)
  skipped?: boolean;
}

export class SavePerioMeasuresDto {
  @ApiProperty({
    type: [PerioSiteMeasureInputDto],
    description:
      'Sitios a escribir. Un sitio sin ningún dato limpia lo que hubiera.',
  })
  @IsArray({ message: 'sites debe ser una lista' })
  @ArrayMaxSize(MAX_SITES_PER_REQUEST, {
    message: `Como máximo ${MAX_SITES_PER_REQUEST} sitios por guardado`,
  })
  @ValidateNested({ each: true })
  @Type(() => PerioSiteMeasureInputDto)
  sites!: PerioSiteMeasureInputDto[];

  @ApiProperty({
    type: [PerioToothMeasureInputDto],
    description: 'Dientes a escribir (movilidad / omitido).',
  })
  @IsArray({ message: 'teeth debe ser una lista' })
  @ArrayMaxSize(MAX_TEETH_PER_REQUEST, {
    message: `Como máximo ${MAX_TEETH_PER_REQUEST} dientes por guardado`,
  })
  @ValidateNested({ each: true })
  @Type(() => PerioToothMeasureInputDto)
  teeth!: PerioToothMeasureInputDto[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 2000,
    description: 'Ausente = no tocar las notas; null o vacío = borrarlas.',
  })
  @IsOptional()
  @IsString({ message: 'Las notas deben ser texto' })
  @MaxLength(2000, { message: 'Las notas no pueden superar 2000 caracteres' })
  notes?: string | null;
}
