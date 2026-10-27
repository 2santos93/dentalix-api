import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class ScheduleRangeDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0=domingo .. 6=sábado' })
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @ApiProperty({
    minimum: 0,
    maximum: 1440,
    description: 'Minutos desde 00:00',
  })
  @IsInt()
  @Min(0)
  @Max(1440)
  startMinute!: number;

  @ApiProperty({ minimum: 0, maximum: 1440 })
  @IsInt()
  @Min(0)
  @Max(1440)
  endMinute!: number;
}

export class ReplaceLocationScheduleDto {
  @ApiPropertyOptional({
    type: String,
    example: 'Europe/Madrid',
    deprecated: true,
    description:
      'Obsoleto (G1): la zona es un dato de la sede (PATCH /locations/:id) y nunca se guarda desde aquí. Solo se acepta, para una web antigua, si es igual a la zona de la sede; distinta (o sede sin zona) es 400.',
  })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiProperty({
    type: [ScheduleRangeDto],
    description:
      'La semana COMPLETA. Un día sin tramos = cerrado. Lista vacía = sede sin restricción.',
  })
  @IsArray()
  // Tope defensivo: una semana no necesita más de unos pocos tramos por día.
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ScheduleRangeDto)
  ranges!: ScheduleRangeDto[];
}
