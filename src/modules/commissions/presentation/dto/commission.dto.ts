import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  ClinicRole,
  CommissionBasis,
  CommissionLineKind,
  CommissionReleaseMode,
} from '@prisma/client';
import {
  COMMISSION_CATEGORY_MAX_LENGTH,
  COMMISSION_RULE_CATEGORIES_MAX,
  COMMISSION_RULE_MESSAGES,
} from '../../domain/commission-rule';
import { SETTLEMENT_PERIOD_MAX_DAYS } from '../../domain/settlement-period';
import {
  CommissionPaymentDto,
  SettlementPaymentSummaryDto,
} from './commission-payment.dto';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_FROM = 'from debe ser una fecha AAAA-MM-DD.';
const PERIOD_TO = 'to debe ser una fecha AAAA-MM-DD.';
const USER_ID = 'userId debe ser un UUID.';

// ---------------------------------------------------------------------------
// Peticiones
// ---------------------------------------------------------------------------

export class CommissionCategoryPercentDto {
  @ApiProperty({
    example: 'Endodoncia',
    maxLength: COMMISSION_CATEGORY_MAX_LENGTH,
  })
  @IsString({ message: COMMISSION_RULE_MESSAGES.categoryName })
  @MaxLength(COMMISSION_CATEGORY_MAX_LENGTH, {
    message: COMMISSION_RULE_MESSAGES.categoryName,
  })
  category!: string;

  @ApiProperty({ example: 40, minimum: 0, maximum: 100 })
  @IsNumber({}, { message: COMMISSION_RULE_MESSAGES.percent })
  percent!: number;
}

export class SaveCommissionRuleDto {
  @ApiProperty({
    enum: CommissionBasis,
    enumName: 'CommissionBasis',
    description:
      'COLLECTED: % de lo cobrado (imputaciones de abonos a los ítems que realizó). PRODUCED: % de lo producido (precio − descuento de los ítems realizados).',
  })
  @IsEnum(CommissionBasis, {
    message: 'La base tiene que ser COLLECTED o PRODUCED.',
  })
  basis!: CommissionBasis;

  @ApiProperty({
    enum: CommissionReleaseMode,
    enumName: 'CommissionReleaseMode',
    description:
      'PER_ITEM: se libera cada prestación al realizarse (y cobrarse, si la base es lo cobrado). PER_PLAN: solo con el plan completo y pagado.',
  })
  @IsEnum(CommissionReleaseMode, {
    message: 'El modo de liberación tiene que ser PER_ITEM o PER_PLAN.',
  })
  releaseMode!: CommissionReleaseMode;

  @ApiProperty({
    example: 35,
    minimum: 0,
    maximum: 100,
    description: '% general (hasta 2 decimales).',
  })
  @IsNumber({}, { message: COMMISSION_RULE_MESSAGES.percent })
  percent!: number;

  @ApiPropertyOptional({
    type: [CommissionCategoryPercentDto],
    maxItems: COMMISSION_RULE_CATEGORIES_MAX,
    description:
      '% propio por categoría del catálogo (sin distinguir mayúsculas); el resto usa el general. Reemplaza la lista guardada.',
  })
  @IsOptional()
  @IsArray({ message: 'categories tiene que ser una lista.' })
  @ArrayMaxSize(COMMISSION_RULE_CATEGORIES_MAX, {
    message: COMMISSION_RULE_MESSAGES.categoriesMax,
  })
  @ValidateNested({ each: true })
  @Type(() => CommissionCategoryPercentDto)
  categories?: CommissionCategoryPercentDto[];

  @ApiPropertyOptional({
    default: true,
    description: 'false = regla desactivada (no se liquida).',
  })
  @IsOptional()
  @IsBoolean({ message: 'active tiene que ser sí o no.' })
  active?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Descontar el costo de laboratorio. Aún no disponible (las órdenes de laboratorio no guardan su costo): true → 400.',
  })
  @IsOptional()
  @IsBoolean({ message: 'deductLabCost tiene que ser sí o no.' })
  deductLabCost?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Descontar la comisión de la pasarela del medio de pago. Aún no disponible (los medios de pago no guardan ese %): true → 400.',
  })
  @IsOptional()
  @IsBoolean({ message: 'deductCardFee tiene que ser sí o no.' })
  deductCardFee?: boolean;
}

export class CommissionPreviewQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'El profesional (usuario). Un DENTIST solo el suyo (otro → 404); sin él, el propio.',
  })
  @IsOptional()
  @IsUUID('all', { message: USER_ID })
  userId?: string;

  @ApiProperty({
    example: '2026-10-01',
    description: `Primer día del período (como mucho ${SETTLEMENT_PERIOD_MAX_DAYS} días).`,
  })
  @Matches(CIVIL_DATE, { message: PERIOD_FROM })
  from!: string;

  @ApiProperty({
    example: '2026-10-31',
    description: 'Último día (inclusive).',
  })
  @Matches(CIVIL_DATE, { message: PERIOD_TO })
  to!: string;
}

export class CloseCommissionSettlementDto {
  @ApiProperty({ format: 'uuid', description: 'El profesional (usuario).' })
  @IsUUID('all', { message: USER_ID })
  userId!: string;

  @ApiProperty({ example: '2026-10-01' })
  @Matches(CIVIL_DATE, { message: PERIOD_FROM })
  from!: string;

  @ApiProperty({ example: '2026-10-31' })
  @Matches(CIVIL_DATE, { message: PERIOD_TO })
  to!: string;
}

export class CommissionSettlementsQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo las de este profesional. Un DENTIST ve siempre solo las suyas.',
  })
  @IsOptional()
  @IsUUID('all', { message: USER_ID })
  userId?: string;
}

// ---------------------------------------------------------------------------
// Respuestas
// ---------------------------------------------------------------------------

export class CommissionProfessionalDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ format: 'uuid' }) membershipId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ClinicRole, enumName: 'ClinicRole' }) role!: ClinicRole;
  @ApiProperty({ description: 'false = ya no está en la clínica.' })
  active!: boolean;
}

export class CommissionCategoryPercentViewDto {
  @ApiProperty() category!: string;
  @ApiProperty() percent!: number;
}

export class CommissionRuleDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: CommissionBasis, enumName: 'CommissionBasis' })
  basis!: CommissionBasis;
  @ApiProperty({
    enum: CommissionReleaseMode,
    enumName: 'CommissionReleaseMode',
  })
  releaseMode!: CommissionReleaseMode;
  @ApiProperty() percent!: number;
  @ApiProperty({ type: [CommissionCategoryPercentViewDto] })
  categories!: CommissionCategoryPercentViewDto[];
  @ApiProperty() active!: boolean;
  @ApiProperty() deductLabCost!: boolean;
  @ApiProperty() deductCardFee!: boolean;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}

export class CommissionDeductionsDto {
  @ApiProperty({
    description:
      'Se puede descontar el costo de laboratorio (hoy no: sin datos).',
  })
  labCost!: boolean;
  @ApiProperty({
    description:
      'Se puede descontar la comisión de la pasarela (hoy no: sin datos).',
  })
  cardFee!: boolean;
}

export class ProfessionalCommissionRuleDto {
  @ApiProperty({ type: CommissionProfessionalDto })
  professional!: CommissionProfessionalDto;
  @ApiProperty({ type: CommissionRuleDto, nullable: true })
  rule!: CommissionRuleDto | null;
}

export class CommissionRulesDto {
  @ApiProperty({ type: [ProfessionalCommissionRuleDto] })
  professionals!: ProfessionalCommissionRuleDto[];
  @ApiProperty({
    type: [String],
    description: 'Categorías del catálogo de la clínica.',
  })
  categories!: string[];
  @ApiProperty({ type: CommissionDeductionsDto })
  deductionsAvailable!: CommissionDeductionsDto;
}

export class CommissionPeriodDto {
  @ApiProperty({ format: 'date' }) from!: string;
  @ApiProperty({ format: 'date' }) to!: string;
}

export class CommissionLinePatientDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
}

export class CommissionLinePaymentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) paidAt!: Date;
  @ApiProperty({ description: 'Importe del abono tal como se cobró.' })
  amount!: number;
  @ApiProperty({ description: 'Moneda del abono.' }) currency!: string;
}

export class CommissionLineDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null en la vista previa.',
  })
  id!: string | null;
  @ApiProperty({ enum: CommissionLineKind, enumName: 'CommissionLineKind' })
  kind!: CommissionLineKind;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'La línea de una liquidación anterior que ajusta.',
  })
  adjustsLineId!: string | null;
  @ApiProperty({ type: CommissionLinePatientDto })
  patient!: CommissionLinePatientDto;
  @ApiProperty({ format: 'uuid' }) treatmentPlanId!: string;
  @ApiProperty({ format: 'uuid' }) treatmentPlanItemId!: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Sede donde se realizó el ítem (la de sus fechas e importes).',
  })
  locationId!: string | null;
  @ApiProperty() catalogCode!: string;
  @ApiProperty() catalogLabel!: string;
  @ApiProperty({ type: String, nullable: true }) category!: string | null;
  @ApiProperty() toothNumber!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: Date | null;
  @ApiProperty({ type: CommissionLinePaymentDto, nullable: true })
  payment!: CommissionLinePaymentDto | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo se liberó (devengos).',
  })
  releasedAt!: Date | null;
  @ApiProperty({ description: 'Moneda de la línea (la del plan).' })
  currency!: string;
  @ApiProperty({
    description: 'Base en la moneda de la línea (un ajuste, con signo).',
  })
  base!: number;
  @ApiProperty() percent!: number;
  @ApiProperty({
    description: 'Honorario en la moneda de la línea (un ajuste, con signo).',
  })
  amount!: number;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'DX-464: el pago vivo de la liquidación que cubre la línea; null en la vista previa o si está pendiente.',
  })
  paidInPaymentId!: string | null;
}

export class CommissionCurrencyTotalDto {
  @ApiProperty() currency!: string;
  @ApiProperty({ description: 'Devengado del período.' }) accrued!: number;
  @ApiProperty({
    description: 'Ajustes de liquidaciones anteriores (con signo).',
  })
  adjustments!: number;
  @ApiProperty({ description: 'A pagar: devengado + ajustes.' }) total!: number;
  @ApiProperty() lines!: number;
}

export class CommissionPreviewDto {
  @ApiProperty({ type: CommissionProfessionalDto })
  professional!: CommissionProfessionalDto;
  @ApiProperty({ type: CommissionPeriodDto }) period!: CommissionPeriodDto;
  @ApiProperty({ type: CommissionRuleDto, nullable: true })
  rule!: CommissionRuleDto | null;
  @ApiProperty({ type: [CommissionLineDto] }) lines!: CommissionLineDto[];
  @ApiProperty({ type: [CommissionCurrencyTotalDto] })
  totals!: CommissionCurrencyTotalDto[];
  @ApiProperty({ type: String, format: 'date', nullable: true }) lastClosedTo!:
    string | null;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description: 'Desde dónde empieza la siguiente liquidación.',
  })
  nextFrom!: string | null;
  @ApiProperty() canClose!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: [
      'NO_RULE',
      'RULE_INACTIVE',
      'PERIOD_NOT_ENDED',
      'OVERLAPS_PREVIOUS',
      'GAP_AFTER_PREVIOUS',
    ],
  })
  blocker!: string | null;
  @ApiProperty({ type: String, nullable: true }) blockerMessage!: string | null;
  @ApiProperty({ type: CommissionDeductionsDto })
  deductionsAvailable!: CommissionDeductionsDto;
}

export class CommissionClosedByDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
}

export class CommissionSettlementSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: CommissionProfessionalDto })
  professional!: CommissionProfessionalDto;
  @ApiProperty({ type: CommissionPeriodDto }) period!: CommissionPeriodDto;
  @ApiProperty({ enum: CommissionBasis, enumName: 'CommissionBasis' })
  basis!: CommissionBasis;
  @ApiProperty({
    enum: CommissionReleaseMode,
    enumName: 'CommissionReleaseMode',
  })
  releaseMode!: CommissionReleaseMode;
  @ApiProperty() percent!: number;
  @ApiProperty({ format: 'date-time' }) closedAt!: Date;
  @ApiProperty({ type: CommissionClosedByDto })
  closedBy!: CommissionClosedByDto;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description: 'Cierre contable antes de liquidar.',
  })
  lockDateBefore!: string | null;
  @ApiProperty({
    format: 'date',
    description: 'Cierre contable tras liquidar (≥ «hasta»).',
  })
  lockDateAfter!: string;
  @ApiProperty({ type: [CommissionCurrencyTotalDto] })
  totals!: CommissionCurrencyTotalDto[];
  @ApiProperty({ type: SettlementPaymentSummaryDto })
  payment!: SettlementPaymentSummaryDto;
}

export class CommissionSettlementDto extends CommissionSettlementSummaryDto {
  @ApiProperty({ type: [CommissionCategoryPercentViewDto] })
  categoryPercents!: CommissionCategoryPercentViewDto[];
  @ApiProperty({ type: [CommissionLineDto] }) lines!: CommissionLineDto[];
  @ApiProperty({
    type: [CommissionPaymentDto],
    description:
      'DX-464: pagos (vivos y anulados), del más reciente al más antiguo.',
  })
  payments!: CommissionPaymentDto[];
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'DX-464: email de la cuenta del profesional (para «Enviar»).',
  })
  professionalEmail!: string | null;
}
