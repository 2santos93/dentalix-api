import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';
import { CURRENCY_CODE_MESSAGE } from '../../../../shared/money/currency-messages';
import {
  PROFITABILITY_BASES,
  PROFITABILITY_SIDES,
  type ProfitabilityBasis,
  type ProfitabilitySide,
} from '../../domain/profitability';
import {
  PROFITABILITY_LINES_DEFAULT_PAGE_SIZE,
  PROFITABILITY_LINES_MAX_PAGE_SIZE,
  PROFITABILITY_MAX_DAYS,
} from '../../application/use-cases/get-profitability.use-case';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const MAX_PAGE = 100000;
const PAYMENT_STATUSES = ['PAID', 'PARTIAL', 'UNPAID'] as const;

// Filtros de GET /reports/profitability y de su CSV (DX-410).
export class ProfitabilityQueryDto {
  @ApiProperty({
    example: '2026-10-01',
    description: `Primer día del período (AAAA-MM-DD, en la zona de cada sede). Como mucho ${PROFITABILITY_MAX_DAYS} días; las dos fechas entre ${PERIOD_DAY_MIN} y ${PERIOD_DAY_MAX} (400 si no).`,
  })
  @Matches(CIVIL_DATE, { message: 'from debe ser una fecha AAAA-MM-DD.' })
  from!: string;

  @ApiProperty({ example: '2026-10-31', description: 'Último día (inclusive)' })
  @Matches(CIVIL_DATE, { message: 'to debe ser una fecha AAAA-MM-DD.' })
  to!: string;

  @ApiProperty({
    enum: PROFITABILITY_BASES,
    description:
      '`CASH` («Caja»): abonos vivos − pagos de gastos vivos, por fecha de pago. `ACCRUAL` («Devengo»): producción realizada − gastos no anulados por fecha de factura, pagados o no.',
  })
  @IsIn(PROFITABILITY_BASES, { message: 'basis debe ser CASH o ACCRUAL.' })
  basis!: ProfitabilityBasis;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo esta sede (403 si no es de las del usuario, no es de la clínica o está retirada: la misma respuesta). Sin él, todas las sedes que ve. La cabecera X-Location-Id no acota.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;
}

// Filtros de GET /reports/profitability/lines: los del informe más la cifra.
export class ProfitabilityLinesQueryDto extends ProfitabilityQueryDto {
  @ApiProperty({
    enum: PROFITABILITY_SIDES,
    description: '`INCOME`: lo que forma los ingresos; `EXPENSE`: los gastos',
  })
  @IsIn(PROFITABILITY_SIDES, { message: 'side debe ser INCOME o EXPENSE.' })
  side!: ProfitabilitySide;

  @ApiProperty({
    description: 'La moneda de la cifra (ISO 4217)',
  })
  @Matches(CURRENCY_CODE, { message: CURRENCY_CODE_MESSAGE })
  currency!: string;

  @ApiPropertyOptional({
    example: 'Laboratorio',
    description:
      'Solo con `side=EXPENSE`: la categoría de la cifra (el nombre tal como sale en el informe). Sin ella, todos los gastos.',
  })
  @IsOptional()
  @IsString({ message: 'category debe ser un texto.' })
  @Length(1, 60, { message: 'category admite de 1 a 60 caracteres.' })
  category?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero.' })
  @Min(1, { message: 'page empieza en 1.' })
  @Max(MAX_PAGE, { message: `page admite hasta ${MAX_PAGE}.` })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: PROFITABILITY_LINES_MAX_PAGE_SIZE,
    default: PROFITABILITY_LINES_DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize debe ser un número entero.' })
  @Min(1, { message: 'pageSize debe ser al menos 1.' })
  @Max(PROFITABILITY_LINES_MAX_PAGE_SIZE, {
    message: `pageSize admite hasta ${PROFITABILITY_LINES_MAX_PAGE_SIZE}.`,
  })
  pageSize?: number;
}

export class ProfitabilityDefinitionDto {
  @ApiProperty({ enum: PROFITABILITY_BASES })
  basis!: string;

  @ApiProperty({ example: 'Caja', description: 'Nombre de la base' })
  label!: string;

  @ApiProperty({ example: 'Cobrado' })
  incomeLabel!: string;

  @ApiProperty({ example: 'Gastos pagados' })
  expensesLabel!: string;

  @ApiProperty({
    example: 'Resultado = cobrado − gastos pagados, por fecha de pago.',
  })
  formula!: string;

  @ApiProperty({
    type: [String],
    description: 'Las reglas de la base, una por línea («Cómo se calcula»)',
  })
  howItIsCalculated!: string[];
}

export class ProfitabilityCategoryDto {
  @ApiProperty({
    example: 'Laboratorio',
    description: 'La categoría del gasto (foto del nombre al registrarlo)',
  })
  category!: string;

  @ApiProperty({ example: 120.5 })
  amount!: number;

  @ApiProperty({
    description: 'Pagos de gastos (Caja) o gastos (Devengo) que la forman',
  })
  count!: number;
}

export class ProfitabilityCurrencyDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras' })
  currency!: string;

  @ApiProperty({ example: 1500, description: 'Ingresos en esta moneda' })
  income!: number;

  @ApiProperty({
    description:
      'Abonos (Caja) o procedimientos realizados (Devengo) que forman los ingresos',
  })
  incomeCount!: number;

  @ApiProperty({ example: 600, description: 'Gastos en esta moneda' })
  expenses!: number;

  @ApiProperty({
    description: 'Pagos de gastos (Caja) o gastos (Devengo)',
  })
  expenseCount!: number;

  @ApiProperty({
    example: 900,
    description: 'Ingresos − gastos; puede ser negativo',
  })
  net!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 60,
    description:
      'Resultado ÷ ingresos en %, con 1 decimal; null sin ingresos (puede ser negativo)',
  })
  margin!: number | null;

  @ApiProperty({
    type: [ProfitabilityCategoryDto],
    description: 'Gastos por categoría, mayor primero',
  })
  categories!: ProfitabilityCategoryDto[];
}

export class ProfitabilityRowDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null = el total del grupo',
  })
  locationId!: string | null;

  @ApiProperty({ example: 'Sede Chacao' })
  name!: string;

  @ApiProperty({ description: 'false = sede desactivada' })
  isActive!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'America/Caracas',
    description: 'Zona de la sede; null en el total',
  })
  timeZone!: string | null;

  @ApiProperty({
    type: [ProfitabilityCurrencyDto],
    description:
      'Una entrada por moneda con movimientos (orden alfabético), nunca sumadas ni convertidas entre sí; vacía = sin movimientos en el período',
  })
  currencies!: ProfitabilityCurrencyDto[];
}

export class ProfitabilityReportDto {
  @ApiProperty({ example: '2026-10-01' })
  from!: string;

  @ApiProperty({ example: '2026-10-31' })
  to!: string;

  @ApiProperty({ enum: PROFITABILITY_BASES })
  basis!: string;

  @ApiProperty({ type: ProfitabilityDefinitionDto })
  definition!: ProfitabilityDefinitionDto;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({
    description: 'El usuario solo ve algunas sedes (DX-089)',
  })
  restrictedToLocations!: boolean;

  @ApiProperty({
    type: [ProfitabilityRowDto],
    description:
      'Una fila por sede visible (o solo la pedida), en orden de creación, también sin movimientos',
  })
  locations!: ProfitabilityRowDto[];

  @ApiProperty({
    type: ProfitabilityRowDto,
    description: '«Total del grupo»: las sedes de `locations`, moneda a moneda',
  })
  total!: ProfitabilityRowDto;

  @ApiProperty({ description: '¿Algún ingreso o gasto en el período?' })
  hasActivity!: boolean;
}

export class ProfitabilityLineDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Id del abono, del ítem realizado, del pago del gasto (Caja) o del gasto (Devengo)',
  })
  id!: string;

  @ApiProperty({
    example: '2026-10-05',
    description:
      'Día civil: de pago (abono, en la zona de su sede; pago del gasto), de realización (procedimiento) o de factura (gasto)',
  })
  date!: string;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ example: 'Sede Chacao' })
  locationName!: string;

  @ApiProperty({ example: 80 })
  amount!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'CCS-000123',
    description:
      'Abono: nº de recibo (o la referencia antigua REC-…). Procedimiento: código · nombre del catálogo. Gasto: proveedor o, sin él, descripción. Nunca el paciente.',
  })
  concept!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Solo gastos: su categoría',
  })
  category!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Efectivo',
    description: 'Caja: el medio de pago',
  })
  method!: string | null;

  @ApiProperty({
    enum: PAYMENT_STATUSES,
    nullable: true,
    description:
      'Solo gastos en Devengo: pagado, en parte o sin pagar (pagos vivos)',
  })
  paymentStatus!: (typeof PAYMENT_STATUSES)[number] | null;
}

export class ProfitabilityLinesDto {
  @ApiProperty({ example: '2026-10-01' })
  from!: string;

  @ApiProperty({ example: '2026-10-31' })
  to!: string;

  @ApiProperty({ enum: PROFITABILITY_BASES })
  basis!: string;

  @ApiProperty({ enum: PROFITABILITY_SIDES })
  side!: string;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras' })
  currency!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  category!: string | null;

  @ApiProperty({
    description:
      'Suma de TODAS las filas (no solo de la página): la cifra del informe',
  })
  total!: number;

  @ApiProperty({ description: 'Filas en total' })
  count!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty({
    type: [ProfitabilityLineDto],
    description: 'De la más reciente a la más antigua',
  })
  lines!: ProfitabilityLineDto[];
}
