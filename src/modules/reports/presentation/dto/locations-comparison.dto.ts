import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import {
  COMPARE_MODES,
  type CompareMode,
} from '../../domain/comparison-period';
import { KPI_KEYS } from '../../domain/kpi-definitions';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';
import { LOCATIONS_COMPARISON_MAX_DAYS } from '../../application/use-cases/get-locations-comparison.use-case';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const TRENDS = ['BETTER', 'WORSE', 'EQUAL'] as const;

// Filtros de GET /reports/locations-comparison y de su CSV (DX-014).
export class LocationsComparisonQueryDto {
  @ApiProperty({
    example: '2026-10-01',
    description: `Primer día del período (AAAA-MM-DD, en la zona de cada sede). Como mucho ${LOCATIONS_COMPARISON_MAX_DAYS} días; las dos fechas entre ${PERIOD_DAY_MIN} y ${PERIOD_DAY_MAX} (400 si no).`,
  })
  @Matches(CIVIL_DATE, { message: 'from debe ser una fecha AAAA-MM-DD.' })
  from!: string;

  @ApiProperty({ example: '2026-10-31', description: 'Último día (inclusive)' })
  @Matches(CIVIL_DATE, { message: 'to debe ser una fecha AAAA-MM-DD.' })
  to!: string;

  @ApiPropertyOptional({
    enum: COMPARE_MODES,
    default: 'previous',
    description:
      '`previous`: los mismos días inmediatamente antes; `previous_year`: las mismas fechas un año antes; `none`: sin comparación.',
  })
  @IsOptional()
  @IsIn(COMPARE_MODES, {
    message: 'compare debe ser previous, previous_year o none.',
  })
  compare?: CompareMode;

  @ApiPropertyOptional({
    description:
      'Solo los importes en esta moneda (ISO 4217). Sin él, todas, cada una por separado: nunca se suman monedas distintas ni se convierten.',
  })
  @IsOptional()
  @Matches(CURRENCY_CODE, {
    message: 'currency debe ser un código ISO 4217 de 3 letras.',
  })
  currency?: string;
}

export class KpiDefinitionDto {
  @ApiProperty({ enum: KPI_KEYS })
  key!: string;

  @ApiProperty({ example: 'Producción' })
  label!: string;

  @ApiProperty({ enum: ['MONEY', 'PERCENT', 'COUNT'] })
  unit!: string;

  @ApiProperty({
    description: 'true = un valor por moneda (lista), nunca sumados',
  })
  perCurrency!: boolean;

  @ApiProperty({
    enum: ['HIGHER_IS_BETTER', 'LOWER_IS_BETTER'],
    description: 'Hacia dónde mejora: el no-show mejora al bajar',
  })
  direction!: string;

  @ApiProperty({
    enum: ['PERCENT', 'POINTS'],
    description:
      'Unidad de `change`: PERCENT = % relativo ((valor − anterior) ÷ |anterior|); POINTS = puntos porcentuales (valor − anterior), en los indicadores que ya son un %',
  })
  changeUnit!: string;

  @ApiProperty({ description: 'Texto de «Cómo se calcula»' })
  howItIsCalculated!: string;
}

export class MetricDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Valor del período. Porcentajes en % con 2 decimales (la ocupación, con tope de 100); null = no se puede calcular (sin base)',
  })
  value!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Valor del período de comparación (null sin comparación)',
  })
  previous!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Variación frente al anterior, 1 decimal, en la unidad `changeUnit` del indicador: % relativo ((valor − anterior) ÷ |anterior|; null con anterior 0) o puntos porcentuales en % de cobro, no-show % y ocupación % (valor − anterior: 8 % → 10 % = 2). null sin anterior',
  })
  change!: number | null;

  @ApiProperty({
    enum: TRENDS,
    nullable: true,
    description: 'Lectura de la variación según la dirección del indicador',
  })
  trend!: (typeof TRENDS)[number] | null;
}

export class CurrencyMetricDto extends MetricDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiPropertyOptional({
    enum: [true],
    description:
      'BE-045: solo en producción y % de cobro, y solo cuando la producción del período comparado en esta moneda no es base (empieza antes de DX-050 con realizados «Sin atribuir», o tuvo cobros sin producción): `change` y `trend` van a null',
  })
  previousUnattributed?: true;
}

export class ComparisonMetricsDto {
  @ApiProperty({ type: [CurrencyMetricDto] })
  production!: CurrencyMetricDto[];

  @ApiProperty({ type: [CurrencyMetricDto] })
  collected!: CurrencyMetricDto[];

  @ApiProperty({ type: [CurrencyMetricDto] })
  collectionRate!: CurrencyMetricDto[];

  @ApiProperty({ type: MetricDto })
  completedAppointments!: MetricDto;

  @ApiProperty({ type: MetricDto })
  noShowRate!: MetricDto;

  @ApiProperty({ type: MetricDto })
  newPatients!: MetricDto;

  @ApiProperty({ type: [CurrencyMetricDto] })
  averageTicket!: CurrencyMetricDto[];

  @ApiProperty({ type: MetricDto })
  occupancy!: MetricDto;
}

export class ComparisonRowDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null en «Total clínica»',
  })
  locationId!: string | null;

  @ApiProperty({ example: 'Sede Norte' })
  name!: string;

  @ApiProperty({ description: 'false = sede desactivada (sigue saliendo)' })
  isActive!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'America/Bogota',
    description: 'Zona con la que la sede corta sus días (null en el total)',
  })
  timeZone!: string | null;

  @ApiProperty({
    description:
      '¿Hubo producción, cobros o citas (atendidas o no-show) en el período?',
  })
  hasActivity!: boolean;

  @ApiProperty({
    description:
      'BE-045: el período comparado no tiene toda su producción atribuida: alguna moneda de producción y % de cobro sale sin variación (`previousUnattributed`)',
  })
  previousPeriodUnattributed!: boolean;

  @ApiProperty({ type: ComparisonMetricsDto })
  metrics!: ComparisonMetricsDto;
}

export class LocationsComparisonDto {
  @ApiProperty({ example: '2026-10-01' })
  from!: string;

  @ApiProperty({ example: '2026-10-31' })
  to!: string;

  @ApiProperty({ enum: COMPARE_MODES })
  compare!: CompareMode;

  @ApiProperty({ type: String, nullable: true, example: '2026-08-31' })
  previousFrom!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-09-30' })
  previousTo!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Moneda del filtro; null = todas, por separado',
  })
  currency!: string | null;

  @ApiProperty({
    type: [KpiDefinitionDto],
    description: 'Los indicadores, en el orden de las columnas',
  })
  kpis!: KpiDefinitionDto[];

  @ApiProperty({
    type: [ComparisonRowDto],
    description: 'Una fila por sede visible, en orden de creación',
  })
  locations!: ComparisonRowDto[];

  @ApiProperty({
    type: ComparisonRowDto,
    description:
      '«Total clínica»: solo las sedes de `locations`; importes por moneda',
  })
  total!: ComparisonRowDto;

  @ApiProperty({ description: '¿Alguna sede tuvo actividad en el período?' })
  hasActivity!: boolean;

  @ApiProperty({
    description:
      '¿Alguna fila (o el total) tiene `previousPeriodUnattributed`? La pantalla lo explica junto a «Producción» y «% de cobro»',
  })
  previousPeriodUnattributed!: boolean;
}
