import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ScheduleRangeDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0=domingo .. 6=sábado' })
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @ApiProperty({ minimum: 0, maximum: 1440, description: 'Minutos desde 00:00' })
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
  @ApiProperty({ example: 'America/Bogota', description: 'Zona IANA de la sede' })
  @IsString()
  @MinLength(1)
  timezone!: string;

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
