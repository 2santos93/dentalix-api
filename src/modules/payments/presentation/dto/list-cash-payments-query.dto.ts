import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { PaymentMethod } from '@prisma/client';
import { MAX_RANGE_DAYS } from '../../application/use-cases/list-cash-payments.use-case';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';

/**
 * Query de `GET /payments` — la caja.
 *
 * `from`/`to` son días civiles, AMBOS inclusive (`from=to` es "un día"), en el
 * calendario de la sede de cada abono (DX-097): cada sede corta el día a
 * medianoche de SU zona IANA (la de su horario en BD; nunca la manda el
 * cliente). El DTO solo comprueba la forma; que el día exista, que `from <= to` y el tope de
 * rango (y el rango de fechas admitido, `checkPeriodDays`) los valida el caso de uso, que es donde se prueban.
 */
export class ListCashPaymentsQueryDto {
  @ApiProperty({
    example: '2026-10-01',
    description:
      'Primer día del período (YYYY-MM-DD), inclusive, en la zona horaria de ' +
      'la sede de cada abono (la de su horario; con varias sedes en zonas ' +
      'distintas, cada una corta el día a su medianoche).',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'from debe ser una fecha AAAA-MM-DD.',
  })
  from!: string;

  @ApiProperty({
    example: '2026-10-31',
    description:
      `Último día del período (YYYY-MM-DD), inclusive (hasta la medianoche ` +
      `del día siguiente en la zona de la sede). Debe ser >= from; ` +
      `el período no puede superar ${MAX_RANGE_DAYS} días. Las dos fechas, ` +
      `entre ${PERIOD_DAY_MIN} y ${PERIOD_DAY_MAX} (400 si no).`,
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'to debe ser una fecha AAAA-MM-DD.',
  })
  to!: string;

  @ApiPropertyOptional({
    enum: PaymentMethod,
    description: 'Solo abonos de este método. Sin él, todos los métodos.',
  })
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  // El caso de uso también lo acota a 100, pero aquí se rechaza: Swagger
  // anuncia `maximum: 100` y un pageSize=5000 que vuelve con 100 filas en
  // silencio contradice el contrato publicado.
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
