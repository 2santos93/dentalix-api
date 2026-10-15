import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { PaymentMethod } from '@prisma/client';
import { MAX_RANGE_DAYS } from '../../application/use-cases/list-cash-payments.use-case';

/**
 * Query de `GET /payments` — la caja.
 *
 * `from`/`to` son días civiles, AMBOS inclusive (`from=to` es "un día"), porque
 * `paidAt` también lo es (ver ListCashPaymentsUseCase.parseCivilDate). El DTO
 * solo comprueba la forma; que el día exista, que `from <= to` y el tope de
 * rango los valida el caso de uso, que es donde se prueban.
 */
export class ListCashPaymentsQueryDto {
  @ApiProperty({
    example: '2026-10-01',
    description: 'Primer día del período (YYYY-MM-DD), inclusive.',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must match YYYY-MM-DD' })
  from!: string;

  @ApiProperty({
    example: '2026-10-31',
    description:
      `Último día del período (YYYY-MM-DD), inclusive. Debe ser >= from; ` +
      `el período no puede superar ${MAX_RANGE_DAYS} días.`,
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must match YYYY-MM-DD' })
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
