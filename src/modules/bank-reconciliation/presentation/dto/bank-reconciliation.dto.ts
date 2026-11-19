import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BankReconciliationMatchKind, PaymentMethodKind } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO4217CurrencyCode,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CURRENCY_CODE_MESSAGE } from '../../../../shared/money/currency-messages';
import { IsNonNegativeMoney } from '../../../../shared/validation/bounded-decimal';
import {
  DATE_ORDERS,
  DECIMAL_SEPARATORS,
} from '../../domain/statement-mapping';

const CIVIL_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const RECONCILIATION_STATUSES = [
  'CONCILIADO',
  'IMPORTE_DISTINTO',
  'MOVIMIENTO_SIN_ABONO',
  'SIN_MOVIMIENTO',
] as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toUpperCase() : value;

// ----------------------------------------------------------------- entrada

export class CreateBankAccountDto {
  @ApiProperty({ maxLength: 80, example: 'Cuenta corriente en bolívares' })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Escribe el nombre de la cuenta.' })
  @MaxLength(80, { message: 'El nombre tiene 80 caracteres como mucho.' })
  name!: string;

  @ApiProperty({
    description:
      'Código ISO 4217 de la cuenta: solo se concilian abonos en esa moneda.',
  })
  @Transform(upper)
  @IsISO4217CurrencyCode({ message: CURRENCY_CODE_MESSAGE })
  currency!: string;

  @ApiPropertyOptional({
    example: 0,
    description:
      'Diferencia de importe aceptada al emparejar solo (≥ 0, 2 decimales). Por defecto 0.',
  })
  @IsOptional()
  @IsNonNegativeMoney()
  @Max(1_000_000)
  amountTolerance?: number;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Medios del catálogo que liquidan en esta cuenta (no efectivo). Un medio, una sola cuenta (409 BANK_PAYMENT_METHOD_TAKEN).',
  })
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  paymentMethodIds!: string[];
}

export class UpdateBankAccountDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Escribe el nombre de la cuenta.' })
  @MaxLength(80, { message: 'El nombre tiene 80 caracteres como mucho.' })
  name?: string;

  @ApiPropertyOptional({
    description: 'Solo si la cuenta aún no tiene movimientos (409).',
  })
  @IsOptional()
  @Transform(upper)
  @IsISO4217CurrencyCode({ message: CURRENCY_CODE_MESSAGE })
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNonNegativeMoney()
  @Max(1_000_000)
  amountTolerance?: number;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: 'Reemplaza la lista entera.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  paymentMethodIds?: string[];

  @ApiPropertyOptional({
    description: 'Desactivada: no admite extractos nuevos.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** Campos de texto del multipart de la vista previa. */
export class PreviewStatementDto {
  @ApiProperty({
    description: 'JSON del mapeo de columnas (BankStatementMappingDto).',
  })
  @IsString()
  @MaxLength(4000)
  mapping!: string;
}

export class ConfirmStatementDto extends PreviewStatementDto {
  @ApiProperty({
    description:
      'SHA-256 del archivo que devolvió la vista previa: si el archivo cambió, 409 BANK_STATEMENT_CHANGED.',
  })
  @IsString()
  @Matches(/^[0-9a-fA-F]{64}$/, { message: 'fileSha256 no es un SHA-256.' })
  fileSha256!: string;
}

export class ReconciliationPeriodQueryDto {
  @ApiProperty({
    example: '2026-10-01',
    description:
      'Primer día (AAAA-MM-DD), inclusive. Período de 93 días como mucho.',
  })
  @Matches(CIVIL_DAY, { message: 'from debe ser una fecha AAAA-MM-DD.' })
  from!: string;

  @ApiProperty({
    example: '2026-10-31',
    description: 'Último día (AAAA-MM-DD), inclusive.',
  })
  @Matches(CIVIL_DAY, { message: 'to debe ser una fecha AAAA-MM-DD.' })
  to!: string;
}

export class ReconciliationItemsQueryDto extends ReconciliationPeriodQueryDto {
  @ApiProperty({ enum: RECONCILIATION_STATUSES })
  @IsIn(RECONCILIATION_STATUSES)
  status!: (typeof RECONCILIATION_STATUSES)[number];

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class AutoMatchDto extends ReconciliationPeriodQueryDto {}

export class CreateBankMatchDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  movementId!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Abono vivo de un medio de la cuenta, en su moneda. El importe puede diferir: lo decide quien empareja.',
  })
  @IsUUID()
  paymentId!: string;
}

// ----------------------------------------------------------------- salida

export class BankStatementMappingDto {
  @ApiPropertyOptional({ description: 'Cabecera de la fecha.' }) date?: string;
  @ApiPropertyOptional({ description: 'Cabecera de la referencia.' })
  reference?: string;
  @ApiPropertyOptional({
    description: 'Cabecera del importe con signo (entradas > 0).',
  })
  amount?: string;
  @ApiPropertyOptional({
    description: 'Cabecera de los créditos (en lugar de `amount`).',
  })
  credit?: string;
  @ApiPropertyOptional({
    description: 'Cabecera de los débitos (opcional, con `credit`).',
  })
  debit?: string;
  @ApiPropertyOptional({
    description: 'Cabecera de la descripción (se guarda truncada a 140).',
  })
  description?: string;
  @ApiProperty({ enum: DATE_ORDERS }) dateOrder!: (typeof DATE_ORDERS)[number];
  @ApiProperty({ enum: DECIMAL_SEPARATORS })
  decimalSeparator!: (typeof DECIMAL_SEPARATORS)[number];
}

export class BankAccountMethodDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: PaymentMethodKind }) kind!: PaymentMethodKind;
}

class UserRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class BankStatementImportDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fileSha256!: string;
  @ApiProperty({ enum: ['CSV', 'XLSX'] }) fileFormat!: string;
  @ApiProperty() totalRows!: number;
  @ApiProperty({ description: 'Entradas válidas del archivo.' })
  creditRows!: number;
  @ApiProperty() createdRows!: number;
  @ApiProperty({
    description: 'Entradas que la cuenta ya tenía (no se duplican).',
  })
  duplicateRows!: number;
  @ApiProperty({ description: 'Salidas o importes en cero (no se guardan).' })
  ignoredRows!: number;
  @ApiProperty() errorRows!: number;
  @ApiProperty() matchedRows!: number;
  @ApiProperty({ type: String, nullable: true, example: '2026-10-01' })
  periodFrom!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '2026-10-31' })
  periodTo!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: UserRefDto }) createdBy!: UserRefDto;
}

export class BankAccountDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() amountTolerance!: number;
  @ApiProperty() active!: boolean;
  @ApiProperty({
    type: BankStatementMappingDto,
    nullable: true,
    description: 'Mapeo guardado del extracto de este banco.',
  })
  columnMapping!: BankStatementMappingDto | null;
  @ApiProperty({ type: [BankAccountMethodDto] })
  paymentMethods!: BankAccountMethodDto[];
  @ApiProperty({ type: BankStatementImportDto, nullable: true })
  lastImport!: BankStatementImportDto | null;
  @ApiProperty() createdAt!: Date;
}

export class BankStatementInspectDto {
  @ApiProperty() fileSha256!: string;
  @ApiProperty({ enum: ['CSV', 'XLSX'] }) fileFormat!: string;
  @ApiProperty({ type: [String] }) headers!: string[];
  @ApiProperty({ type: BankStatementMappingDto })
  suggestedMapping!: BankStatementMappingDto;
  @ApiProperty() usesSavedMapping!: boolean;
  @ApiProperty({
    type: 'array',
    items: { type: 'array', items: { type: 'string' } },
  })
  sampleRows!: string[][];
  @ApiProperty() totalRows!: number;
}

export class BankStatementIssueDto {
  @ApiProperty() rowNumber!: number;
  @ApiProperty({
    enum: [
      'DATE_INVALID',
      'AMOUNT_INVALID',
      'REFERENCE_TOO_LONG',
      'EXTRA_CELLS',
    ],
  })
  code!: string;
  @ApiProperty() message!: string;
}

export class BankStatementPreviewRowDto {
  @ApiProperty() rowNumber!: number;
  @ApiProperty({ example: '2026-10-15' }) bookedOn!: string;
  @ApiProperty({ type: String, nullable: true }) reference!: string | null;
  @ApiProperty() amount!: number;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ description: 'La cuenta ya tiene este movimiento.' })
  duplicate!: boolean;
}

export class BankStatementPreviewDto {
  @ApiProperty() fileSha256!: string;
  @ApiProperty({ enum: ['CSV', 'XLSX'] }) fileFormat!: string;
  @ApiProperty() totalRows!: number;
  @ApiProperty() creditRows!: number;
  @ApiProperty() newRows!: number;
  @ApiProperty() duplicateRows!: number;
  @ApiProperty() ignoredRows!: number;
  @ApiProperty() errorRows!: number;
  @ApiProperty({ type: String, nullable: true }) periodFrom!: string | null;
  @ApiProperty({ type: String, nullable: true }) periodTo!: string | null;
  @ApiProperty({
    type: [BankStatementIssueDto],
    description: 'Las primeras 200 filas con error.',
  })
  issues!: BankStatementIssueDto[];
  @ApiProperty({
    type: [BankStatementPreviewRowDto],
    description: 'Las primeras 10 entradas.',
  })
  rows!: BankStatementPreviewRowDto[];
}

export class BankStatementConfirmDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fileSha256!: string;
  @ApiProperty() rows!: number;
  @ApiProperty() valid!: number;
  @ApiProperty() created!: number;
  @ApiProperty() duplicates!: number;
  @ApiProperty() ignored!: number;
  @ApiProperty() errors!: number;
  @ApiProperty({ description: 'Emparejados automáticos creados.' })
  matched!: number;
  @ApiProperty({ type: String, nullable: true }) periodFrom!: string | null;
  @ApiProperty({ type: String, nullable: true }) periodTo!: string | null;
}

class ReconciliationCountsDto {
  @ApiProperty() CONCILIADO!: number;
  @ApiProperty() IMPORTE_DISTINTO!: number;
  @ApiProperty() MOVIMIENTO_SIN_ABONO!: number;
  @ApiProperty() SIN_MOVIMIENTO!: number;
}

export class ReconciliationSummaryDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ type: ReconciliationCountsDto })
  counts!: ReconciliationCountsDto;
}

export class BankMovementDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() bookedOn!: string;
  @ApiProperty({ type: String, nullable: true }) reference!: string | null;
  @ApiProperty() amount!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
}

class RefNameDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

class PatientRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
}

export class ReconciliationPaymentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Día del abono en la zona de su sede.' })
  paidOn!: string;
  @ApiProperty() amount!: number;
  @ApiProperty({
    description:
      'Lo que llega al banco: importe + ajustes por medio de pago (DX-516).',
  })
  collectedAmount!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ type: String, nullable: true }) reference!: string | null;
  @ApiProperty({ type: RefNameDto, nullable: true })
  paymentMethod!: RefNameDto | null;
  @ApiProperty({ type: String, nullable: true }) receiptNumber!: string | null;
  @ApiProperty({
    description: 'Tiene comprobante (GET /payments/:id/proof/url).',
  })
  hasProof!: boolean;
  @ApiProperty({ type: PatientRefDto }) patient!: PatientRefDto;
  @ApiProperty({ type: RefNameDto }) location!: RefNameDto;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  treatmentPlanId!: string | null;
}

class MatchRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: BankReconciliationMatchKind })
  kind!: BankReconciliationMatchKind;
  @ApiProperty() createdAt!: Date;
}

export class ReconciliationItemDto {
  @ApiProperty({ enum: RECONCILIATION_STATUSES }) status!: string;
  @ApiProperty({ type: BankMovementDto, nullable: true })
  movement!: BankMovementDto | null;
  @ApiProperty({ type: ReconciliationPaymentDto, nullable: true })
  payment!: ReconciliationPaymentDto | null;
  @ApiProperty({ type: MatchRefDto, nullable: true })
  match!: MatchRefDto | null;
}

export class ReconciliationItemsDto extends ReconciliationSummaryDto {
  @ApiProperty({ enum: RECONCILIATION_STATUSES }) status!: string;
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ type: [ReconciliationItemDto] })
  items!: ReconciliationItemDto[];
}

export class CandidatePaymentDto extends ReconciliationPaymentDto {
  @ApiProperty() referenceMatches!: boolean;
}

export class CandidateReportDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() amount!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ type: String, nullable: true }) reference!: string | null;
  @ApiProperty() paidOn!: string;
  @ApiProperty({ type: RefNameDto }) paymentMethod!: RefNameDto;
  @ApiProperty({ type: PatientRefDto }) patient!: PatientRefDto;
  @ApiProperty() referenceMatches!: boolean;
}

export class MovementCandidatesDto {
  @ApiProperty({ type: BankMovementDto }) movement!: BankMovementDto;
  @ApiProperty({ type: [CandidatePaymentDto] })
  payments!: CandidatePaymentDto[];
  @ApiProperty({
    type: [CandidateReportDto],
    description:
      'Reportes de pago PENDIENTES (DX-569) que pueden ser este movimiento: confirmar uno crea el abono.',
  })
  reports!: CandidateReportDto[];
}

export class BankMatchDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) movementId!: string;
  @ApiProperty({ format: 'uuid' }) paymentId!: string;
  @ApiProperty({ enum: BankReconciliationMatchKind })
  kind!: BankReconciliationMatchKind;
}

export class AutoMatchResultDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() matched!: number;
}

export class IdDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
}
