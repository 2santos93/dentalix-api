import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsISO4217CurrencyCode,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { MAX_UPCOMING_LIMIT } from '../../application/use-cases/get-doctor-dashboard.use-case';

// Uppercase-normalizes ISO 4217 codes before validation -- same convention
// as CreatePaymentDto (payments, PAY-T3).
function toUpperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.toUpperCase() : value;
}

// `from`/`to` son días CIVILES (YYYY-MM-DD). El período de ingresos es
// semiabierto `[from, to)`: `to` es el día SIGUIENTE al último incluido (la web
// manda «Hasta» + 1). Cada sede corta los días a medianoche de SU zona IANA
// (la de su horario en BD, nunca la del cliente; DX-097), así un abono de las
// 20:00 en una sede a UTC−5 cuenta en su día aunque en UTC ya sea el siguiente.
export class DashboardQueryDto {
  @ApiProperty({
    example: '2026-07-01',
    description:
      'Primer día civil del período (YYYY-MM-DD), inclusive, desde la ' +
      'medianoche de la zona horaria de cada sede.',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must match YYYY-MM-DD' })
  from!: string;

  @ApiProperty({
    example: '2026-07-31',
    description:
      'Día civil (YYYY-MM-DD) SIGUIENTE al último del período: exclusivo ' +
      '([from, to)). El corte es la medianoche de ese día en la zona horaria ' +
      'de cada sede. from = to da un período vacío.',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must match YYYY-MM-DD' })
  to!: string;

  @ApiProperty({
    description:
      'ISO 4217 currency code every payment amount is converted into.',
  })
  @Transform(toUpperCase)
  @IsISO4217CurrencyCode({
    message: 'currency must be a real ISO 4217 currency code',
  })
  currency!: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_UPCOMING_LIMIT,
    default: 5,
    description: `Cuántas próximas citas devolver. Tope: ${MAX_UPCOMING_LIMIT} (un valor mayor responde 400).`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'upcomingLimit debe ser un número entero.' })
  @Min(1, { message: 'upcomingLimit debe ser al menos 1.' })
  @Max(MAX_UPCOMING_LIMIT, {
    message: `upcomingLimit admite hasta ${MAX_UPCOMING_LIMIT}.`,
  })
  upcomingLimit?: number;
}
