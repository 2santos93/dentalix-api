import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
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
import { PRODUCTION_ITEMS_PAGE_SIZE } from '../../application/use-cases/get-production-by-procedure.use-case';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const MAX_PAGE = 100000;
const MAX_PAGE_SIZE = 100;

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Filtros de GET /reports/production-by-procedure, su CSV y su detalle (DX-423).
export class ProductionByProcedureQueryDto {
  @ApiProperty({
    example: '2026-10-01',
    description: `Primer día del período (AAAA-MM-DD, en la zona de la sede donde se realizó). Como mucho 24 meses por calendario («to» anterior a «from» + 24 meses); las dos fechas entre ${PERIOD_DAY_MIN} y ${PERIOD_DAY_MAX} (400 si no).`,
  })
  @Matches(CIVIL_DATE, { message: 'from debe ser una fecha AAAA-MM-DD.' })
  from!: string;

  @ApiProperty({ example: '2026-10-31', description: 'Último día (inclusive)' })
  @Matches(CIVIL_DATE, { message: 'to debe ser una fecha AAAA-MM-DD.' })
  to!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo lo realizado en esta sede (403 si no es de las del usuario o no es de la clínica: la misma respuesta, sin decir qué sedes existen). Sin él, todas las sedes que ve. La cabecera X-Location-Id no acota.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo lo que realizó este profesional (usuario). Un DENTIST solo puede pedir el suyo (403 si no); sin él, ve igualmente solo lo suyo.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'professionalId debe ser un UUID.' })
  professionalId?: string;

  @ApiPropertyOptional({
    example: 'Operatoria',
    description: 'Solo los procedimientos de esta categoría del catálogo',
  })
  @IsOptional()
  @Transform(trimmed)
  @IsString({ message: 'category debe ser un texto.' })
  @Length(1, 80, { message: 'category admite de 1 a 80 caracteres.' })
  category?: string;
}

export class ProductionItemsQueryDto extends ProductionByProcedureQueryDto {
  @ApiProperty({
    format: 'uuid',
    description: 'El procedimiento del catálogo de la fila',
  })
  @IsUUID('all', { message: 'catalogItemId debe ser un UUID.' })
  catalogItemId!: string;

  @ApiPropertyOptional({
    description: 'La moneda de la fila (ISO 4217); sin ella, todas',
  })
  @IsOptional()
  @Matches(CURRENCY_CODE, {
    message: 'currency debe ser un código ISO 4217 de 3 letras.',
  })
  currency?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero.' })
  @Min(1, { message: 'page empieza en 1.' })
  @Max(MAX_PAGE, { message: `page admite hasta ${MAX_PAGE}.` })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: PRODUCTION_ITEMS_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize debe ser un número entero.' })
  @Min(1, { message: 'pageSize debe ser al menos 1.' })
  @Max(MAX_PAGE_SIZE, { message: `pageSize admite hasta ${MAX_PAGE_SIZE}.` })
  pageSize?: number;
}

export class ProductionAmountsDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({ description: 'Procedimientos realizados' })
  count!: number;

  @ApiProperty({ description: 'Σ precio' })
  gross!: number;

  @ApiProperty({ description: 'Σ descuento' })
  discounts!: number;

  @ApiProperty({ description: 'Bruto − descuentos' })
  net!: number;
}

export class ProductionTotalsDto extends ProductionAmountsDto {
  @ApiProperty({
    description: 'Honorario medio: neto ÷ cantidad (2 decimales)',
  })
  averageNet!: number;
}

export class ProcedureRowDto extends ProductionTotalsDto {
  @ApiProperty({ format: 'uuid' })
  catalogItemId!: string;

  @ApiProperty({ example: 'D2391' })
  code!: string;

  @ApiProperty({ example: 'Resina' })
  label!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Categoría del catálogo; null = «Sin categoría»',
  })
  category!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Honorario medio de catálogo: Σ precio de catálogo congelado en cada ítem (DX-105) ÷ los ítems que lo tienen. null si ninguno lo tiene',
  })
  catalogAverage!: number | null;

  @ApiProperty({ description: 'Ítems con precio de catálogo congelado' })
  catalogCount!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Diferencia % (1 decimal) del neto cobrado frente al catálogo, en los ítems que lo tienen: (Σ neto − Σ catálogo) ÷ Σ catálogo. Negativo = por debajo del catálogo. null sin catálogo o con catálogo 0',
  })
  differencePercent!: number | null;
}

export class CategoryTotalsDto extends ProductionTotalsDto {
  @ApiProperty({ type: String, nullable: true })
  category!: string | null;
}

export class ProductionFiltersDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  locationName!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'En un DENTIST, siempre él',
  })
  professionalId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  professionalName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  category!: string | null;
}

export class ProductionLocationOptionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ description: 'false = sede desactivada (sigue saliendo)' })
  isActive!: boolean;
}

export class ProductionProfessionalOptionDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty()
  fullName!: string;
}

export class ProductionOptionsDto {
  @ApiProperty({
    type: [ProductionLocationOptionDto],
    description: 'Las sedes que ve quien consulta (DX-089)',
  })
  locations!: ProductionLocationOptionDto[];

  @ApiProperty({
    type: [ProductionProfessionalOptionDto],
    description: 'Quién atiende (DENTIST o ADMIN); a un DENTIST, solo él mismo',
  })
  professionals!: ProductionProfessionalOptionDto[];

  @ApiProperty({ type: [String], description: 'Categorías del catálogo' })
  categories!: string[];
}

export class ProductionByProcedureDto {
  @ApiProperty({ example: '2026-10-01' })
  from!: string;

  @ApiProperty({ example: '2026-10-31' })
  to!: string;

  @ApiProperty({
    enum: ['CLINIC', 'OWN'],
    description: 'CLINIC: todo el equipo (ADMIN); OWN: solo lo suyo (DENTIST)',
  })
  scope!: 'CLINIC' | 'OWN';

  @ApiProperty({ type: ProductionFiltersDto })
  filters!: ProductionFiltersDto;

  @ApiProperty({ type: ProductionOptionsDto })
  options!: ProductionOptionsDto;

  @ApiProperty({
    type: [ProcedureRowDto],
    description:
      'Una fila por procedimiento y moneda, por categoría («Sin categoría» al final) y código',
  })
  rows!: ProcedureRowDto[];

  @ApiProperty({
    type: [CategoryTotalsDto],
    description: 'Subtotal de cada categoría, por moneda',
  })
  categoryTotals!: CategoryTotalsDto[];

  @ApiProperty({
    type: [ProductionTotalsDto],
    description: 'Total por moneda: nunca se suman monedas distintas',
  })
  totals!: ProductionTotalsDto[];

  @ApiProperty({
    type: [ProductionAmountsDto],
    description:
      'Realizados «Sin atribuir» (sin fecha o sin sede de realización, DX-305), por moneda: sin fecha no caen en ningún período, así que salen sea cual sea. Los que no tienen sede solo los ve quien ve todas las sedes sin elegir una',
  })
  unattributed!: ProductionAmountsDto[];

  @ApiProperty({ description: '¿Hay filas o «Sin atribuir»?' })
  hasActivity!: boolean;
}

export class ProductionItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  completedAt!: Date;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null = paciente eliminado (no se nombra ni se enlaza)',
  })
  patientId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  patientName!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  professionalId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  professionalName!: string | null;

  @ApiProperty({ format: 'uuid', description: 'Sede donde se realizó' })
  locationId!: string;

  @ApiProperty()
  locationName!: string;

  @ApiProperty({
    example: 'America/Bogota',
    description: 'Zona de la sede donde se realizó: la fecha se pinta con ella',
  })
  timeZone!: string;

  @ApiProperty({ example: '16' })
  toothNumber!: string;

  @ApiProperty()
  currency!: string;

  @ApiProperty()
  price!: number;

  @ApiProperty()
  discount!: number;

  @ApiProperty({ description: 'Precio − descuento' })
  net!: number;
}

export class ProductionItemsDto {
  @ApiProperty({ type: [ProductionItemDto] })
  items!: ProductionItemDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
