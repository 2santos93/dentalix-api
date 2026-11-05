import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';
import {
  UNALLOCATED_DEFAULT_PAGE_SIZE,
  UNALLOCATED_MAX_PAGE_SIZE,
} from '../../application/use-cases/get-unallocated-payments.use-case';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGE = 100000;

// Filtros de GET /reports/unallocated-payments y de su CSV (DX-399).
export class UnallocatedPaymentsFiltersDto {
  @ApiProperty({
    example: '2026-10-01',
    description: `Primer día del período (AAAA-MM-DD, en la zona de la sede del abono). Como mucho 24 meses por calendario; las dos fechas entre ${PERIOD_DAY_MIN} y ${PERIOD_DAY_MAX} (400 si no).`,
  })
  @Matches(CIVIL_DATE, { message: 'from debe ser una fecha AAAA-MM-DD.' })
  from!: string;

  @ApiProperty({ example: '2026-10-31', description: 'Último día (inclusive)' })
  @Matches(CIVIL_DATE, { message: 'to debe ser una fecha AAAA-MM-DD.' })
  to!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo los abonos de esta sede (403 si no es de las del usuario o no es de la clínica: la misma respuesta, sin decir qué sedes existen). Sin él, todas las sedes que ve. La cabecera X-Location-Id no acota.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;
}

export class UnallocatedPaymentsQueryDto extends UnallocatedPaymentsFiltersDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero.' })
  @Min(1, { message: 'page empieza en 1.' })
  @Max(MAX_PAGE, { message: `page admite hasta ${MAX_PAGE}.` })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: UNALLOCATED_MAX_PAGE_SIZE,
    default: UNALLOCATED_DEFAULT_PAGE_SIZE,
    description: `Tope: ${UNALLOCATED_MAX_PAGE_SIZE} (un valor mayor se recorta)`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize debe ser un número entero.' })
  @Min(1, { message: 'pageSize debe ser al menos 1.' })
  pageSize?: number;
}

export class UnallocatedPatientDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;
}

export class UnallocatedLocationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;
}

export class UnallocatedLocationOptionDto extends UnallocatedLocationDto {
  @ApiProperty()
  isActive!: boolean;
}

export class UnallocatedPaymentRowDto {
  @ApiProperty({ format: 'uuid' })
  paymentId!: string;

  @ApiProperty({ type: UnallocatedPatientDto })
  patient!: UnallocatedPatientDto;

  @ApiProperty({
    type: UnallocatedLocationDto,
    description:
      'Sede del abono: el importe y la fecha se pintan con el formato de esa sede',
  })
  location!: UnallocatedLocationDto;

  @ApiProperty({
    example: '2026-10-20',
    description: 'Día civil del abono en la zona de su sede',
  })
  paidOn!: string;

  @ApiProperty({ example: 100, description: 'En la moneda del abono' })
  paymentAmount!: number;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  paymentCurrency!: string;

  @ApiProperty({ format: 'uuid' })
  planId!: string;

  @ApiProperty({
    description:
      'Código ISO 4217 de 3 letras. Moneda del plan: `allocated` y `unallocated` van en ella',
  })
  planCurrency!: string;

  @ApiProperty({
    example: 70,
    description: 'Lo imputado a ítems del plan, en la moneda del plan',
  })
  allocated!: number;

  @ApiProperty({
    example: 30,
    description:
      'Lo que queda a cuenta: el abono en la moneda del plan menos lo imputado y menos lo que el plan ya devolvió o traspasó de su saldo a favor (DX-253; se descuenta de los abonos más recientes primero, nunca por debajo de 0); siempre > 0. Un abono que queda en 0 no sale',
  })
  unallocated!: number;
}

export class UnallocatedTotalDto {
  @ApiProperty({
    description: 'Código ISO 4217 de 3 letras (moneda del plan).',
  })
  currency!: string;

  @ApiProperty({ description: 'Abonos con algo sin imputar en esta moneda' })
  count!: number;

  @ApiProperty()
  allocated!: number;

  @ApiProperty()
  unallocated!: number;
}

export class UnallocatedFiltersEchoDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  locationName!: string | null;
}

export class UnallocatedOptionsDto {
  @ApiProperty({
    type: [UnallocatedLocationOptionDto],
    description: 'Las sedes que ve quien consulta, para el filtro',
  })
  locations!: UnallocatedLocationOptionDto[];
}

export class UnallocatedPaymentsPageDto {
  @ApiProperty({ example: '2026-10-01' })
  from!: string;

  @ApiProperty({ example: '2026-10-31' })
  to!: string;

  @ApiProperty({ type: UnallocatedFiltersEchoDto })
  filters!: UnallocatedFiltersEchoDto;

  @ApiProperty({ type: UnallocatedOptionsDto })
  options!: UnallocatedOptionsDto;

  @ApiProperty({
    type: [UnallocatedPaymentRowDto],
    description:
      'Del abono más reciente al más antiguo. Solo abonos vivos a un plan que se cobra (no cancelado ni rechazado), con base y con algo sin imputar, neto de lo ya devuelto o traspasado (ver `unallocated`)',
  })
  items!: UnallocatedPaymentRowDto[];

  @ApiProperty({
    description:
      'Filas de la lista completa. Paginación por desplazamiento sobre una lista que se recalcula en cada petición',
  })
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty({
    type: [UnallocatedTotalDto],
    description:
      'Por moneda del plan, sobre TODAS las filas del período y las sedes (no solo la página)',
  })
  totals!: UnallocatedTotalDto[];

  @ApiProperty({
    description:
      'Abonos del período en otra moneda que la del plan a los que todavía les falta la tasa de su día: no se pueden imputar y no están en las cifras (uno en la moneda del plan sin base espera al barrido y no se cuenta)',
  })
  paymentsWithoutRateCount!: number;
}
