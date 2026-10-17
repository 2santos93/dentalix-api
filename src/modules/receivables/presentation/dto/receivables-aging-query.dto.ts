import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  RECEIVABLES_DEFAULT_PAGE_SIZE,
  RECEIVABLES_MAX_PAGE_SIZE,
} from '../../application/use-cases/get-receivables-aging.use-case';

const MAX_AGE_DAYS = 36500;
const MAX_BALANCE = 999_999_999_999.99;
// Tope de página: evita un OFFSET desorbitado (una lista de cobro no llega ahí).
const MAX_PAGE = 100000;

// Filtros de GET /receivables/aging y GET /receivables/aging.csv (DX-145).
export class ReceivablesAgingFiltersDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sede de la deuda. Sin él, la de la cabecera X-Location-Id; sin ninguna, toda la clínica.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({
    example: 'COP',
    description: 'Solo esta moneda (ISO 4217), sin convertir',
  })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency debe ser un código ISO 4217 de 3 letras (p. ej. COP).',
  })
  currency?: string;

  @ApiPropertyOptional({
    minimum: 0,
    description:
      'Deuda mínima del paciente en alguna moneda (en `currency`, si se da)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'minBalance debe ser un importe con hasta 2 decimales.' },
  )
  @Min(0, { message: 'minBalance no puede ser negativo.' })
  @Max(MAX_BALANCE, { message: 'minBalance es demasiado grande.' })
  minBalance?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_AGE_DAYS,
    description:
      'Días mínimos de la deuda vencida más antigua (91 = «más de 90 días»)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'minAgeDays debe ser un número entero de días.' })
  @Min(0, { message: 'minAgeDays no puede ser negativo.' })
  @Max(MAX_AGE_DAYS, {
    message: `minAgeDays admite hasta ${MAX_AGE_DAYS} días.`,
  })
  minAgeDays?: number;
}

export class ReceivablesAgingQueryDto extends ReceivablesAgingFiltersDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero.' })
  @Min(1, { message: 'page empieza en 1.' })
  @Max(MAX_PAGE, { message: `page admite hasta ${MAX_PAGE}.` })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: RECEIVABLES_MAX_PAGE_SIZE,
    default: RECEIVABLES_DEFAULT_PAGE_SIZE,
    description: `Tope: ${RECEIVABLES_MAX_PAGE_SIZE} (un valor mayor se recorta)`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize debe ser un número entero.' })
  @Min(1, { message: 'pageSize debe ser al menos 1.' })
  pageSize?: number;
}
