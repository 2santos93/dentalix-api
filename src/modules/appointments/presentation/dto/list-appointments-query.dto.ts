import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { MAX_PROVIDER_COLUMNS } from '../../application/use-cases/list-appointments.use-case';

/** `?providerIds=a&providerIds=b` llega como array; `?providerIds=a`, como string. */
function toArray({ value }: { value: unknown }): unknown {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

export class ListAppointmentsQueryDto {
  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  from!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: MAX_PROVIDER_COLUMNS,
    description: `DX-121: columnas de la vista Día. Hasta ${MAX_PROVIDER_COLUMNS} ids del personal activo de la clínica (otro id da 400). Se repite el parámetro: ?providerIds=a&providerIds=b.`,
  })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PROVIDER_COLUMNS, {
    message: `Puedes ver como mucho ${MAX_PROVIDER_COLUMNS} profesionales a la vez`,
  })
  @IsUUID('all', { each: true })
  providerIds?: string[];

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'DX-121: sede de la agenda. Si falta, la del request (X-Location-Id) o todas.',
  })
  @IsOptional()
  @IsUUID()
  locationId?: string;
}
