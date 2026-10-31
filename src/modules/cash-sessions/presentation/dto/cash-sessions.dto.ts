import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CashAdjustmentKind,
  CashSessionStatus,
  PaymentMethod,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  CASH_DIFFERENCE_REASON_MAX,
  CASH_MAX_AMOUNT,
  CASH_MAX_CURRENCIES,
  CASH_NOTES_MAX,
  CASH_REASON_MAX,
  CASH_REASON_MIN,
} from '../../domain/cash-session.entity';

function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;
const CURRENCY_MESSAGE = 'currency debe ser un código ISO 4217 de 3 letras.';
const METHOD_MESSAGE = 'method debe ser CASH, CARD, TRANSFER u OTHER.';
const AMOUNT_OPTIONS = {
  maxDecimalPlaces: 2,
  allowNaN: false,
  allowInfinity: false,
};
/** Pares (moneda, método) de un arqueo: 4 métodos por moneda. */
const MAX_COUNT_LINES = CASH_MAX_CURRENCIES * 4;

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export class CashFloatInputDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  @Matches(CURRENCY_PATTERN, { message: CURRENCY_MESSAGE })
  currency!: string;

  @ApiProperty({ minimum: 0, example: 100000 })
  @IsNumber(AMOUNT_OPTIONS, {
    message: 'amount debe ser un importe con hasta 2 decimales.',
  })
  @Min(0, { message: 'El fondo inicial no puede ser negativo.' })
  @Max(CASH_MAX_AMOUNT, { message: 'El fondo inicial es demasiado grande.' })
  amount!: number;
}

export class OpenCashSessionDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sede de la caja. Sin él, la de la cabecera X-Location-Id; sin ninguna, la principal.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiProperty({
    type: [CashFloatInputDto],
    description:
      'Fondo inicial (en efectivo) por moneda. Vacío = sin fondo. Una vez por moneda.',
  })
  @IsArray({ message: 'floats debe ser una lista.' })
  @ArrayMaxSize(CASH_MAX_CURRENCIES, {
    message: `El fondo inicial admite como mucho ${CASH_MAX_CURRENCIES} monedas.`,
  })
  @ValidateNested({ each: true })
  @Type(() => CashFloatInputDto)
  floats!: CashFloatInputDto[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: CASH_NOTES_MAX,
  })
  @IsOptional()
  @IsString({ message: 'notes debe ser un texto.' })
  @MaxLength(CASH_NOTES_MAX, {
    message: `Las notas admiten hasta ${CASH_NOTES_MAX} caracteres.`,
  })
  notes?: string | null;
}

export class CashCountInputDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  @Matches(CURRENCY_PATTERN, { message: CURRENCY_MESSAGE })
  currency!: string;

  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  @IsEnum(PaymentMethod, { message: METHOD_MESSAGE })
  method!: PaymentMethod;

  @ApiProperty({ minimum: 0, example: 350000 })
  @IsNumber(AMOUNT_OPTIONS, {
    message: 'counted debe ser un importe con hasta 2 decimales.',
  })
  @Min(0, { message: 'Lo contado no puede ser negativo.' })
  @Max(CASH_MAX_AMOUNT, { message: 'Lo contado es demasiado grande.' })
  counted!: number;
}

export class CloseCashSessionDto {
  @ApiProperty({
    type: [CashCountInputDto],
    description:
      'Lo contado por moneda y método. Un par esperado que no venga cuenta como 0.',
  })
  @IsArray({ message: 'counts debe ser una lista.' })
  @ArrayMaxSize(MAX_COUNT_LINES, {
    message: `El arqueo admite como mucho ${MAX_COUNT_LINES} líneas.`,
  })
  @ValidateNested({ each: true })
  @Type(() => CashCountInputDto)
  counts!: CashCountInputDto[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: CASH_REASON_MIN,
    maxLength: CASH_DIFFERENCE_REASON_MAX,
    description:
      'Obligatorio si el arqueo no cuadra (diferencia distinta de 0).',
  })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'differenceReason debe ser un texto.' })
  @Length(CASH_REASON_MIN, CASH_DIFFERENCE_REASON_MAX, {
    message: `El motivo de la diferencia debe tener entre ${CASH_REASON_MIN} y ${CASH_DIFFERENCE_REASON_MAX} caracteres.`,
  })
  differenceReason?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: CASH_NOTES_MAX,
  })
  @IsOptional()
  @IsString({ message: 'notes debe ser un texto.' })
  @MaxLength(CASH_NOTES_MAX, {
    message: `Las notas admiten hasta ${CASH_NOTES_MAX} caracteres.`,
  })
  notes?: string | null;
}

export class ReopenCashSessionDto {
  @ApiProperty({
    minLength: CASH_REASON_MIN,
    maxLength: CASH_REASON_MAX,
    example: 'Faltó registrar un abono con tarjeta',
  })
  @Transform(trim)
  @IsString({ message: 'reason debe ser un texto.' })
  @Length(CASH_REASON_MIN, CASH_REASON_MAX, {
    message: `El motivo debe tener entre ${CASH_REASON_MIN} y ${CASH_REASON_MAX} caracteres.`,
  })
  reason!: string;
}

export class CreateCashAdjustmentDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  @Matches(CURRENCY_PATTERN, { message: CURRENCY_MESSAGE })
  currency!: string;

  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  @IsEnum(PaymentMethod, { message: METHOD_MESSAGE })
  method!: PaymentMethod;

  @ApiProperty({
    example: -20000,
    description:
      'Con signo: positivo suma al esperado, negativo resta. Nunca 0.',
  })
  @IsNumber(AMOUNT_OPTIONS, {
    message: 'amount debe ser un importe con hasta 2 decimales.',
  })
  @Min(-CASH_MAX_AMOUNT, { message: 'El ajuste es demasiado grande.' })
  @Max(CASH_MAX_AMOUNT, { message: 'El ajuste es demasiado grande.' })
  amount!: number;

  @ApiProperty({ minLength: CASH_REASON_MIN, maxLength: CASH_REASON_MAX })
  @Transform(trim)
  @IsString({ message: 'reason debe ser un texto.' })
  @Length(CASH_REASON_MIN, CASH_REASON_MAX, {
    message: `El motivo debe tener entre ${CASH_REASON_MIN} y ${CASH_REASON_MAX} caracteres.`,
  })
  reason!: string;
}

export class CashSettingsDto {
  @ApiProperty({
    description:
      '«Exigir caja abierta»: sin caja abierta en la sede no se registra un abono en efectivo (409).',
  })
  @IsBoolean({ message: 'requireOpenSession debe ser true o false.' })
  requireOpenSession!: boolean;

  @ApiProperty({
    description:
      '«Arqueo ciego»: quien cierra cuenta antes de ver el esperado; ADMIN lo ve siempre.',
  })
  @IsBoolean({ message: 'blindClose debe ser true o false.' })
  blindClose!: boolean;
}

export class ListCashSessionsQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo esta sede. Sin él, la de X-Location-Id; sin ninguna, todas.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({
    example: '2026-10-01',
    description:
      'Primer día de apertura (YYYY-MM-DD), en la zona de cada sede.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from debe ser AAAA-MM-DD.' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-10-31',
    description:
      'Último día de apertura (YYYY-MM-DD), inclusive. Como mucho 366 días.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to debe ser AAAA-MM-DD.' })
  to?: string;

  @ApiPropertyOptional({
    enum: CashSessionStatus,
    enumName: 'CashSessionStatus',
  })
  @IsOptional()
  @IsEnum(CashSessionStatus, { message: 'status debe ser OPEN o CLOSED.' })
  status?: CashSessionStatus;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class CurrentCashSessionQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sede. Sin él, la de X-Location-Id; sin ninguna, la principal.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

export class CashStaffRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  fullName!: string | null;
}

export class CashLocationRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;
}

export class CashMoneyDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty()
  amount!: number;
}

export class CashPatientRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;
}

export class CashExpectedLineDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  method!: PaymentMethod;

  @ApiProperty({ description: 'Fondo inicial (solo efectivo)' })
  opening!: number;

  @ApiProperty({ description: 'Abonos del turno que cuentan' })
  payments!: number;

  @ApiProperty()
  paymentsCount!: number;

  @ApiProperty({ description: 'Ajustes que entraron en esta caja (con signo)' })
  adjustments!: number;

  @ApiProperty({
    description:
      'Salidas de caja menor del turno (DX-274), en positivo: se restan. Solo en efectivo.',
  })
  outflows!: number;

  @ApiProperty()
  outflowsCount!: number;

  @ApiProperty({
    description:
      'opening + payments + adjustments − outflows (puede ser negativo)',
  })
  expected!: number;
}

export class CashClosingLineDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  method!: PaymentMethod;

  @ApiProperty()
  opening!: number;

  @ApiProperty()
  expected!: number;

  @ApiProperty()
  counted!: number;

  @ApiProperty({ description: 'counted − expected' })
  difference!: number;
}

export class CashClosingDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: '1 el primero; 2, 3… tras cada reapertura' })
  sequence!: number;

  @ApiProperty({ format: 'date-time' })
  closedAt!: Date;

  @ApiProperty({ type: CashStaffRefDto })
  closedBy!: CashStaffRefDto;

  @ApiProperty()
  blind!: boolean;

  @ApiProperty()
  hasDifference!: boolean;

  @ApiProperty({ type: String, nullable: true })
  differenceReason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({
    example: '2026-10-17',
    description:
      'Fecha de bloqueo contable sugerida para la sede (día civil del cierre, DX-091). No bloquea nada todavía.',
  })
  suggestedLockDate!: string;

  @ApiProperty({ type: [CashClosingLineDto] })
  lines!: CashClosingLineDto[];
}

export class CashReopeningDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  sequence!: number;

  @ApiProperty({ format: 'date-time' })
  reopenedAt!: Date;

  @ApiProperty({ type: CashStaffRefDto })
  reopenedBy!: CashStaffRefDto;

  @ApiProperty()
  reason!: string;
}

export class CashSessionPaymentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'date-time' })
  paidAt!: Date;

  @ApiProperty({ example: '2026-10-17', description: 'Día civil en la sede' })
  paidOn!: string;

  @ApiProperty()
  amount!: number;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({
    enum: PaymentMethod,
    enumName: 'PaymentMethod',
    nullable: true,
  })
  method!: PaymentMethod | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'PRI-000012',
    description:
      'Número del recibo del abono; una forma de pago de un cobro dividido lleva el del recibo único del cobro (DX-390). `null` si el abono es anterior a la numeración.',
  })
  receiptNumber!: string | null;

  @ApiProperty({ type: CashPatientRefDto })
  patient!: CashPatientRefDto;

  @ApiProperty({ type: CashStaffRefDto, nullable: true })
  createdBy!: CashStaffRefDto | null;
}

export class CashVoidedPaymentDto extends CashSessionPaymentDto {
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  voidedAt!: Date | null;

  @ApiProperty({ type: CashStaffRefDto, nullable: true })
  voidedBy!: CashStaffRefDto | null;

  @ApiProperty({ type: String, nullable: true })
  voidReason!: string | null;

  @ApiProperty({
    description:
      'Anulado con la caja ya cerrada: sigue contando aquí y la anulación es un ajuste en otra caja.',
  })
  bookedAsAdjustment!: boolean;
}

export class CashOutflowDto {
  @ApiProperty({ format: 'uuid', description: 'Id del pago de gasto' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  expenseId!: string;

  @ApiProperty({ example: 'Mensajería' })
  category!: string;

  @ApiProperty({ type: String, nullable: true })
  supplier!: string | null;

  @ApiProperty()
  amount!: number;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: CashStaffRefDto })
  createdBy!: CashStaffRefDto;
}

/** DX-253: devolución de saldo a favor en efectivo (egreso de la caja). */
export class CashCreditRefundDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'DEV-BOG-000001' })
  number!: string;

  @ApiProperty()
  amount!: number;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: CashStaffRefDto })
  createdBy!: CashStaffRefDto;

  @ApiProperty({ type: CashPatientRefDto })
  patient!: CashPatientRefDto;
}

export class CashVoidedOutflowDto extends CashOutflowDto {
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  voidedAt!: Date | null;

  @ApiProperty({ type: CashStaffRefDto, nullable: true })
  voidedBy!: CashStaffRefDto | null;

  @ApiProperty({ type: String, nullable: true })
  voidReason!: string | null;

  @ApiProperty({
    description:
      'Anulada con la caja ya cerrada: sigue restando aquí y la anulación es un ajuste OUTFLOW_VOID en otra caja.',
  })
  bookedAsAdjustment!: boolean;
}

export class CashAdjustmentExpensePaymentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  expenseId!: string;

  @ApiProperty()
  category!: string;

  @ApiProperty({ type: String, nullable: true })
  supplier!: string | null;
}

export class CashAdjustmentPaymentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: CashPatientRefDto })
  patient!: CashPatientRefDto;

  @ApiProperty({ example: '2026-10-16' })
  paidOn!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Número del recibo del abono; una forma de pago de un cobro dividido lleva el del recibo único del cobro (DX-390). `null` si el abono es anterior a la numeración.',
  })
  receiptNumber!: string | null;
}

export class CashSessionRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'date-time' })
  openedAt!: Date;

  @ApiProperty({ type: CashStaffRefDto })
  openedBy!: CashStaffRefDto;
}

export class CashAdjustmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: CashAdjustmentKind,
    enumName: 'CashAdjustmentKind',
    description:
      'VOID: anulación de un abono de una caja cerrada. LATE_PAYMENT: abono con fecha de un día ya cerrado. CORRECTION: corrección de un ADMIN. OUTFLOW_VOID: anulación (positiva) de una salida de caja de una caja cerrada.',
  })
  kind!: CashAdjustmentKind;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  method!: PaymentMethod;

  @ApiProperty({ description: 'Con signo' })
  amount!: number;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: CashStaffRefDto })
  createdBy!: CashStaffRefDto;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Caja donde cuenta; null = pendiente de la siguiente que se abra en la sede',
  })
  sessionId!: string | null;

  @ApiProperty({ type: CashAdjustmentPaymentDto, nullable: true })
  payment!: CashAdjustmentPaymentDto | null;

  @ApiProperty({
    type: CashAdjustmentExpensePaymentDto,
    nullable: true,
    description: 'OUTFLOW_VOID: la salida de caja anulada y su gasto',
  })
  expensePayment!: CashAdjustmentExpensePaymentDto | null;

  @ApiProperty({
    type: CashSessionRefDto,
    nullable: true,
    description: 'La caja cerrada de la que viene (enlace al original)',
  })
  originalSession!: CashSessionRefDto | null;
}

export class CashSessionSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: CashSessionStatus, enumName: 'CashSessionStatus' })
  status!: CashSessionStatus;

  @ApiProperty({ type: CashLocationRefDto })
  location!: CashLocationRefDto;

  @ApiProperty({ type: CashStaffRefDto })
  openedBy!: CashStaffRefDto;

  @ApiProperty({ format: 'date-time' })
  openedAt!: Date;

  @ApiProperty({
    example: '2026-10-17',
    description: 'Día civil de la apertura en la sede',
  })
  openedOn!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt!: Date | null;

  @ApiProperty({ type: CashStaffRefDto, nullable: true })
  closedBy!: CashStaffRefDto | null;

  @ApiProperty()
  reopenCount!: number;

  @ApiProperty({
    type: [CashMoneyDto],
    description: 'Fondo inicial por moneda',
  })
  floats!: CashMoneyDto[];

  @ApiProperty({
    type: [CashMoneyDto],
    description:
      'Diferencia por moneda del último cierre (vacía si está abierta)',
  })
  differences!: CashMoneyDto[];
}

export class CashSessionCapabilitiesDto {
  @ApiProperty()
  close!: boolean;

  @ApiProperty()
  reopen!: boolean;

  @ApiProperty()
  adjust!: boolean;
}

export class CashSessionDetailDto extends CashSessionSummaryDto {
  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ example: 'America/Bogota' })
  timeZone!: string;

  @ApiProperty({
    description:
      'Arqueo ciego para quien consulta: `expected` y `payments` vienen a null hasta cerrar.',
  })
  blindHidden!: boolean;

  @ApiProperty({ type: [CashExpectedLineDto], nullable: true })
  expected!: CashExpectedLineDto[] | null;

  @ApiProperty({ type: [CashSessionPaymentDto], nullable: true })
  payments!: CashSessionPaymentDto[] | null;

  @ApiProperty({
    type: [CashVoidedPaymentDto],
    description:
      'Anulados (DX-049): no cuentan en el esperado salvo si se anularon con la caja cerrada',
  })
  voidedPayments!: CashVoidedPaymentDto[];

  @ApiProperty({
    type: [CashOutflowDto],
    description:
      'Salidas de caja menor vivas del turno (DX-274). Se ven también con el arqueo ciego.',
  })
  outflows!: CashOutflowDto[];

  @ApiProperty({
    type: [CashVoidedOutflowDto],
    description:
      'Salidas anuladas: no restan salvo si se anularon con la caja cerrada',
  })
  voidedOutflows!: CashVoidedOutflowDto[];

  @ApiProperty({
    type: [CashCreditRefundDto],
    description:
      'DX-253: devoluciones de saldo a favor en efectivo del turno: restan en el esperado de CASH (dentro de «Salidas»).',
  })
  creditRefunds!: CashCreditRefundDto[];

  @ApiProperty({
    type: [CashAdjustmentDto],
    description: 'Ajustes que cuentan en esta caja',
  })
  adjustments!: CashAdjustmentDto[];

  @ApiProperty({
    type: [CashAdjustmentDto],
    description: 'Ajustes nacidos de esta caja ya cerrada, que cuentan en otra',
  })
  laterAdjustments!: CashAdjustmentDto[];

  @ApiProperty({
    type: CashClosingDto,
    nullable: true,
    description: 'Cierre vigente',
  })
  closing!: CashClosingDto | null;

  @ApiProperty({
    type: [CashClosingDto],
    description: 'Todos los cierres, del último al primero',
  })
  closings!: CashClosingDto[];

  @ApiProperty({ type: [CashReopeningDto] })
  reopenings!: CashReopeningDto[];

  @ApiProperty({ type: CashSessionCapabilitiesDto })
  can!: CashSessionCapabilitiesDto;
}

export class CashSessionPageDto {
  @ApiProperty({ type: [CashSessionSummaryDto] })
  items!: CashSessionSummaryDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}

export class CurrentCashSessionDto {
  @ApiProperty({ format: 'uuid', description: 'Sede consultada' })
  locationId!: string;

  @ApiProperty({ type: CashSettingsDto })
  settings!: CashSettingsDto;

  @ApiProperty({
    type: CashSessionDetailDto,
    nullable: true,
    description: 'La caja abierta de quien consulta en la sede, o null',
  })
  session!: CashSessionDetailDto | null;
}
