import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import {
  DiscountReason,
  PriceSource,
  TreatmentPlanStatus,
} from '@prisma/client';
import {
  DISCOUNT_REPORT_DEFAULT_PAGE_SIZE,
  DISCOUNT_REPORT_MAX_DAYS,
  DISCOUNT_REPORT_MAX_PAGE_SIZE,
} from '../../application/use-cases/get-discount-report.use-case';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGE = 100000;

// Filtros de GET /reports/discounts y de su CSV (DX-204).
export class DiscountReportFiltersDto {
  @ApiProperty({
    example: '2026-10-01',
    description: `Primer día del periodo (AAAA-MM-DD, en la zona de cada sede). Como mucho ${DISCOUNT_REPORT_MAX_DAYS} días; las dos fechas entre ${PERIOD_DAY_MIN} y ${PERIOD_DAY_MAX} (400 si no).`,
  })
  @Matches(CIVIL_DATE, { message: 'from debe ser una fecha AAAA-MM-DD.' })
  from!: string;

  @ApiProperty({ example: '2026-10-31', description: 'Último día (inclusive)' })
  @Matches(CIVIL_DATE, { message: 'to debe ser una fecha AAAA-MM-DD.' })
  to!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sede del descuento. Sin él, la de la cabecera X-Location-Id; sin ninguna, toda la clínica.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Solo los descuentos que dio este miembro del equipo',
  })
  @IsOptional()
  @IsUUID('all', { message: 'professionalId debe ser un UUID.' })
  professionalId?: string;
}

export class DiscountReportQueryDto extends DiscountReportFiltersDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero.' })
  @Min(1, { message: 'page empieza en 1.' })
  @Max(MAX_PAGE, { message: `page admite hasta ${MAX_PAGE}.` })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: DISCOUNT_REPORT_MAX_PAGE_SIZE,
    default: DISCOUNT_REPORT_DEFAULT_PAGE_SIZE,
    description: `Tope: ${DISCOUNT_REPORT_MAX_PAGE_SIZE} (un valor mayor se recorta)`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize debe ser un número entero.' })
  @Min(1, { message: 'pageSize debe ser al menos 1.' })
  pageSize?: number;
}

export class DiscountReportTotalDto {
  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ description: 'Ítems con descuento en esta moneda' })
  items!: number;

  @ApiProperty({
    description:
      'Bruto: suma del precio de referencia de esos mismos ítems (el de catálogo si el precio se rebajó; si no, el precio)',
  })
  gross!: number;

  @ApiProperty({
    description:
      'Suma de su descuento efectivo: rebajas de precio frente al catálogo + descuentos (SEC-041)',
  })
  discount!: number;

  @ApiProperty({ description: 'Descuento sobre el bruto, en % (2 decimales)' })
  percentOfGross!: number;
}

/** SEC-047: rebajas de convenio de una moneda, aparte de los totales de DX-204. */
export class AgreementReductionTotalDto {
  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ description: 'Líneas con rebaja de convenio en esta moneda' })
  items!: number;

  @ApiProperty({
    description:
      'Suma de las rebajas de convenio (precio de catálogo − precio del convenio)',
  })
  reduction!: number;
}

export class DiscountReportItemDto {
  @ApiProperty({ format: 'uuid' })
  itemId!: string;

  @ApiProperty({ format: 'uuid' })
  planId!: string;

  @ApiProperty({ enum: TreatmentPlanStatus })
  planStatus!: TreatmentPlanStatus;

  @ApiProperty({ type: String, nullable: true })
  planOptionLabel!: string | null;

  @ApiProperty({ format: 'date-time' })
  planCreatedAt!: Date;

  @ApiProperty({
    example: '2026-10-01',
    description: 'Día civil de alta del plan',
  })
  planCreatedOn!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty()
  patientName!: string;

  @ApiProperty()
  toothNumber!: string;

  @ApiProperty({ description: 'Procedimiento del catálogo' })
  procedure!: string;

  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'SEC-041: precio de catálogo al dar de alta el ítem (null = ítem libre)',
  })
  catalogPrice!: number | null;

  @ApiProperty({ description: 'Precio pactado del ítem' })
  price!: number;

  @ApiProperty({
    description:
      'SEC-041: rebaja del precio frente al de catálogo (0 si no la hay)',
  })
  priceReduction!: number;

  @ApiProperty({ description: 'Descuento del ítem (campo `discount`)' })
  itemDiscount!: number;

  @ApiProperty({
    description: 'Descuento total: rebaja de precio + descuento del ítem',
  })
  discount!: number;

  @ApiProperty({
    description:
      '% del descuento total sobre el precio de referencia (el de catálogo si se rebajó), 2 decimales',
  })
  percent!: number;

  @ApiProperty({ enum: DiscountReason, nullable: true })
  reason!: DiscountReason | null;

  @ApiProperty({ type: String, nullable: true })
  reasonNote!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null en los descuentos anteriores a DX-204',
  })
  discountById!: string | null;

  @ApiProperty({ type: String, nullable: true })
  discountByName!: string | null;

  @ApiProperty({
    format: 'date-time',
    description: 'Hora del descuento (antes de DX-204, la de alta del ítem)',
  })
  discountAt!: Date;

  @ApiProperty({
    example: '2026-10-02',
    description: 'Día civil del descuento en la zona de su sede',
  })
  discountOn!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  locationName!: string | null;

  @ApiProperty({
    enum: PriceSource,
    nullable: true,
    description:
      'DX-105: de dónde salió el precio de referencia (null en ítems anteriores)',
  })
  priceSource!: PriceSource | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Convenio con el que se resolvió el precio al dar de alta el ítem',
  })
  agreementName!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'DX-105: precio de catálogo al dar de alta el ítem (sin convenio)',
  })
  basePrice!: number | null;

  @ApiProperty({
    description:
      'SEC-047: rebaja de convenio (precio de catálogo − precio del convenio; 0 sin convenio). Aparte del descuento total',
  })
  agreementReduction!: number;

  @ApiProperty({
    description:
      'SEC-047: % de la rebaja de convenio sobre el precio de catálogo, 2 decimales',
  })
  agreementPercent!: number;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'SEC-047: quién asignó el convenio al paciente',
  })
  agreementAssignedById!: string | null;

  @ApiProperty({ type: String, nullable: true })
  agreementAssignedByName!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'SEC-047: quién dio de alta el ítem (null en los anteriores a SEC-047)',
  })
  createdById!: string | null;

  @ApiProperty({ type: String, nullable: true })
  createdByName!: string | null;
}

export class DiscountReportLocationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sede Norte' })
  name!: string;
}

export class DiscountReportScopeDto {
  @ApiProperty({
    type: DiscountReportLocationDto,
    nullable: true,
    description:
      'Sede del filtro (parámetro o cabecera); null = toda la clínica',
  })
  location!: DiscountReportLocationDto | null;
}

export class DiscountReportDto {
  @ApiProperty({ example: '2026-10-01' })
  from!: string;

  @ApiProperty({ example: '2026-10-31' })
  to!: string;

  @ApiProperty({ type: DiscountReportScopeDto })
  scope!: DiscountReportScopeDto;

  @ApiProperty({
    type: [DiscountReportTotalDto],
    description: 'Por moneda, sin convertir',
  })
  totals!: DiscountReportTotalDto[];

  @ApiProperty({
    type: [AgreementReductionTotalDto],
    description:
      'SEC-047: rebajas de convenio por moneda. Van aparte: `totals` solo cuenta los descuentos (como en DX-204)',
  })
  agreementTotals!: AgreementReductionTotalDto[];

  @ApiProperty({
    type: [DiscountReportItemDto],
    description: 'Página de ítems, más recientes primero',
  })
  items!: DiscountReportItemDto[];

  @ApiProperty({
    description:
      'Líneas del periodo (todas las páginas): descuentos y rebajas de convenio',
  })
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
