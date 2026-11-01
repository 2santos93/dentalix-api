import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsISO4217CurrencyCode,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Min,
  MaxLength,
} from 'class-validator';
import { PaymentMethod } from '@prisma/client';
import {
  IsMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';
import {
  CREDIT_MAX_REFERENCE_PAYMENTS,
  CREDIT_PAYMENTS_REQUIRED_MESSAGE,
  CREDIT_REASON_MAX,
  CREDIT_REASON_REQUIRED_MESSAGE,
} from '../../domain/patient-credit';

const AMOUNT_MESSAGE =
  'El importe tiene que ser un número mayor que 0 con 2 decimales como máximo.';
const CURRENCY_MESSAGE = 'La moneda tiene que ser un código ISO 4217 válido.';
const METHOD_MESSAGE =
  'El método de la devolución tiene que ser CASH, CARD, TRANSFER u OTHER.';
const TARGET_MESSAGE = 'Elige el plan de destino.';
const PAYMENT_ID_MESSAGE = 'Cada abono de referencia tiene que ser un UUID.';
const CAP_MESSAGE =
  'El tope de recepción tiene que ser un número mayor o igual que 0 con 2 decimales como máximo.';

function toUpperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

export class TransferCreditDto {
  @ApiProperty({ format: 'uuid', description: 'Plan vivo del mismo paciente.' })
  @IsUUID('all', { message: TARGET_MESSAGE })
  targetPlanId!: string;

  @ApiProperty({ example: 200000, maximum: MONEY_MAX })
  @IsNumber({}, { message: AMOUNT_MESSAGE })
  @IsPositive({ message: AMOUNT_MESSAGE })
  @IsMoney({ message: AMOUNT_MESSAGE })
  amount!: number;

  @ApiProperty({ description: 'La moneda del plan de origen (ISO 4217).' })
  @Transform(toUpperCase)
  @IsISO4217CurrencyCode({ message: CURRENCY_MESSAGE })
  currency!: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: CREDIT_REASON_MAX,
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: CREDIT_REASON_REQUIRED_MESSAGE })
  @MaxLength(CREDIT_REASON_MAX, { message: CREDIT_REASON_REQUIRED_MESSAGE })
  reason?: string | null;
}

export class RefundCreditDto {
  @ApiProperty({ example: 100000, maximum: MONEY_MAX })
  @IsNumber({}, { message: AMOUNT_MESSAGE })
  @IsPositive({ message: AMOUNT_MESSAGE })
  @IsMoney({ message: AMOUNT_MESSAGE })
  amount!: number;

  @ApiProperty({ description: 'La moneda del plan (ISO 4217).' })
  @Transform(toUpperCase)
  @IsISO4217CurrencyCode({ message: CURRENCY_MESSAGE })
  currency!: string;

  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  @IsEnum(PaymentMethod, { message: METHOD_MESSAGE })
  method!: PaymentMethod;

  @ApiProperty({ minLength: 3, maxLength: CREDIT_REASON_MAX })
  @IsString({ message: CREDIT_REASON_REQUIRED_MESSAGE })
  @MaxLength(CREDIT_REASON_MAX, { message: CREDIT_REASON_REQUIRED_MESSAGE })
  reason!: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'Abonos del plan que se devuelven (al menos uno).',
  })
  @IsArray({ message: CREDIT_PAYMENTS_REQUIRED_MESSAGE })
  @ArrayMinSize(1, { message: CREDIT_PAYMENTS_REQUIRED_MESSAGE })
  @ArrayMaxSize(CREDIT_MAX_REFERENCE_PAYMENTS, {
    message: CREDIT_PAYMENTS_REQUIRED_MESSAGE,
  })
  @IsUUID('all', { each: true, message: PAYMENT_ID_MESSAGE })
  paymentIds!: string[];
}

export class UpdateCreditPolicyDto {
  @ApiProperty({ example: 0, minimum: 0, maximum: MONEY_MAX })
  @IsNumber({}, { message: CAP_MESSAGE })
  @Min(0, { message: CAP_MESSAGE })
  @IsMoney({ message: CAP_MESSAGE })
  receptionMaxAmount!: number;
}

export class CreditPolicyDto {
  @ApiProperty({
    description:
      'Tope de RECEPTION por traspaso o devolución, en la moneda del plan (0 = no puede). ADMIN no tiene tope.',
  })
  receptionMaxAmount!: number;
}

export class CreditTransferDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty({ format: 'uuid' }) sourcePlanId!: string;
  @ApiProperty({ format: 'uuid' }) targetPlanId!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() amount!: number;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ format: 'uuid' }) createdById!: string;
  @ApiProperty() createdAt!: Date;
}

export class CreditTransferResultDto extends CreditTransferDto {
  @ApiProperty({ description: 'Saldo a favor que le queda al plan de origen.' })
  sourceCreditAfter!: number;
}

class RefundPaymentRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() paidAt!: string;
  @ApiProperty() amount!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() receiptNumber!: string;
}

class RefundReceiptPatientDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() documentType!: string;
  @ApiProperty({ type: String, nullable: true }) docTypeLabel!: string | null;
  @ApiProperty({ type: String, nullable: true }) docNumber!: string | null;
}

class RefundReceiptLocationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
  @ApiProperty({ example: 'UTC', description: 'IANA de la sede.' })
  timeZone!: string;
}

class RefundReceiptPlanDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) label!: string | null;
  @ApiProperty() createdAt!: string;
}

class RefundReceiptClinicDto {
  @ApiProperty() name!: string;
}

class RefundReceiptByDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) fullName!: string | null;
}

export class RefundReceiptSnapshotDto {
  @ApiProperty() number!: string;
  @ApiProperty() issuedAt!: string;
  @ApiProperty({ type: RefundReceiptClinicDto })
  clinic!: RefundReceiptClinicDto;
  @ApiProperty({ type: RefundReceiptLocationDto })
  location!: RefundReceiptLocationDto;
  @ApiProperty({ type: RefundReceiptPatientDto })
  patient!: RefundReceiptPatientDto;
  @ApiProperty({ type: RefundReceiptPlanDto }) plan!: RefundReceiptPlanDto;
  @ApiProperty() amount!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  method!: PaymentMethod;
  @ApiProperty() reason!: string;
  @ApiProperty({ type: [RefundPaymentRefDto] })
  payments!: RefundPaymentRefDto[];
  @ApiProperty() creditBefore!: number;
  @ApiProperty() creditAfter!: number;
  @ApiProperty({ type: RefundReceiptByDto }) refundedBy!: RefundReceiptByDto;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  cashSessionId!: string | null;
}

export class CreditRefundDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'DEV-BOG-000001' }) number!: string;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty({ format: 'uuid' }) treatmentPlanId!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() amount!: number;
  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  method!: PaymentMethod;
  @ApiProperty() reason!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  cashSessionId!: string | null;
  @ApiProperty({ type: [String] }) paymentIds!: string[];
  @ApiProperty({ format: 'uuid' }) createdById!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: RefundReceiptSnapshotDto })
  snapshot!: RefundReceiptSnapshotDto;
}

export class PatientCreditMovementsDto {
  @ApiProperty({ type: [CreditTransferDto] }) transfers!: CreditTransferDto[];
  @ApiProperty({ type: [CreditRefundDto] }) refunds!: CreditRefundDto[];
}
