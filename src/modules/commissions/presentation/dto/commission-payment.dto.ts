import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { PaymentMethod } from '@prisma/client';
import { SIGNATURE_MAX_CHARS } from '../../../consents/presentation/dto/sign-patient-consent.dto';
import { PAYMENT_REFERENCE_MAX } from '../../domain/settlement-payments';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Peticiones
// ---------------------------------------------------------------------------

export class PayCommissionSettlementDto {
  @ApiProperty({
    example: 'USD',
    description: 'Moneda del pago: cada moneda se paga aparte, sin convertir.',
  })
  @IsString()
  @Matches(/^[A-Za-z]{3}$/, {
    message: 'currency debe ser un código de moneda de 3 letras.',
  })
  currency!: string;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description:
      'Líneas de la liquidación que se pagan (todas de esa moneda). Sin ellas, todas las pendientes de la moneda.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @IsUUID('all', { each: true, message: 'lineIds debe ser una lista de UUID.' })
  lineIds?: string[];

  @ApiProperty({
    example: '2026-11-05',
    description: 'Día del pago (AAAA-MM-DD).',
  })
  @IsString()
  @Matches(CIVIL_DATE, { message: 'paidOn debe ser una fecha AAAA-MM-DD.' })
  paidOn!: string;

  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiPropertyOptional({
    maxLength: PAYMENT_REFERENCE_MAX,
    description: 'Referencia del pago (nº de transferencia…).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(PAYMENT_REFERENCE_MAX)
  reference?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sede del gasto. Sin ella, la sede activa de la petición o la sede por defecto de la clínica.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({
    description:
      'Sale de la caja abierta de quien paga (efectivo y hoy), como un gasto pagado desde la caja.',
  })
  @IsOptional()
  @IsBoolean()
  fromCashSession?: boolean;
}

export class VoidCommissionPaymentDto {
  @ApiProperty({ minLength: 5, maxLength: 500 })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class SignCommissionReceiptDto {
  @ApiProperty({
    maxLength: 120,
    description: 'Nombre completo de quien firma.',
  })
  @IsString()
  @MaxLength(200)
  signerName!: string;

  @ApiProperty({
    description: 'PNG (data:image/png;base64,… o base64), máx. 200 KB.',
  })
  @IsString()
  @MaxLength(SIGNATURE_MAX_CHARS)
  signature!: string;

  @ApiProperty({ description: '«Recibido conforme» (debe ser true).' })
  @IsBoolean()
  @Equals(true, {
    message: 'Confirma que recibiste el pago conforme antes de firmar.',
  })
  accepted!: boolean;
}

// ---------------------------------------------------------------------------
// Respuestas
// ---------------------------------------------------------------------------

export class CommissionCurrencyPaymentStateDto {
  @ApiProperty() currency!: string;
  @ApiProperty({ description: 'A pagar: Σ de las líneas.' }) total!: number;
  @ApiProperty({ description: 'Σ de las líneas con pago vivo.' }) paid!: number;
  @ApiProperty({ description: 'total − pagado (≤ 0: nada más que pagar).' })
  pending!: number;
  @ApiProperty() pendingLines!: number;
}

export class SettlementPaymentSummaryDto {
  @ApiProperty({
    enum: ['UNPAID', 'PARTIALLY_PAID', 'PAID', 'NOTHING_TO_PAY'],
    enumName: 'CommissionSettlementPaymentStatus',
  })
  status!: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'NOTHING_TO_PAY';
  @ApiProperty({ type: [CommissionCurrencyPaymentStateDto] })
  currencies!: CommissionCurrencyPaymentStateDto[];
}

export class CommissionPaymentReceiptDto {
  @ApiProperty({
    enum: ['NONE', 'PENDING', 'EXPIRED', 'SIGNED'],
    enumName: 'CommissionReceiptStatus',
  })
  status!: 'NONE' | 'PENDING' | 'EXPIRED' | 'SIGNED';
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  requestedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  signedAt!: Date | null;
  @ApiProperty({ type: String, nullable: true }) signerName!: string | null;
}

export class CommissionPaymentLocationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class CommissionPaymentUserDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
}

export class CommissionPaymentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) settlementId!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() amount!: number;
  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  method!: PaymentMethod;
  @ApiProperty({ format: 'date' }) paidOn!: string;
  @ApiProperty({ type: String, nullable: true }) reference!: string | null;
  @ApiProperty({ type: CommissionPaymentLocationDto })
  location!: CommissionPaymentLocationDto;
  @ApiProperty({ format: 'uuid', description: 'El gasto de la sede.' })
  expenseId!: string;
  @ApiProperty({ type: [String], format: 'uuid' }) lineIds!: string[];
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: CommissionPaymentUserDto })
  createdBy!: CommissionPaymentUserDto;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  voidedAt!: Date | null;
  @ApiProperty({ type: CommissionPaymentUserDto, nullable: true })
  voidedBy!: CommissionPaymentUserDto | null;
  @ApiProperty({ type: String, nullable: true }) voidReason!: string | null;
  @ApiProperty({ type: CommissionPaymentReceiptDto })
  receipt!: CommissionPaymentReceiptDto;
}

export class CommissionReceiptLinkDto {
  @ApiProperty({
    description: 'La URL con el token: solo en esta respuesta (no se guarda).',
  })
  url!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: Date;
}

export class PublicReceiptLineDto {
  @ApiProperty({ enum: ['ACCRUAL', 'ADJUSTMENT'] }) kind!:
    'ACCRUAL' | 'ADJUSTMENT';
  @ApiProperty({ description: 'Solo iniciales.' }) patientInitials!: string;
  @ApiProperty() catalogCode!: string;
  @ApiProperty() catalogLabel!: string;
  @ApiProperty() toothNumber!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true }) day!:
    string | null;
  @ApiProperty() base!: number;
  @ApiProperty() percent!: number;
  @ApiProperty() amount!: number;
}

export class PublicReceiptPaymentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date' }) paidOn!: string;
  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  method!: PaymentMethod;
  @ApiProperty({ type: String, nullable: true }) reference!: string | null;
  @ApiProperty() currency!: string;
  @ApiProperty() amount!: number;
  @ApiProperty() locationName!: string;
}

export class PublicReceiptPeriodDto {
  @ApiProperty({ format: 'date' }) from!: string;
  @ApiProperty({ format: 'date' }) to!: string;
}

export class PublicReceiptFormatDto {
  @ApiProperty({ type: String, nullable: true }) locale!: string | null;
  @ApiProperty({ type: String, nullable: true }) hourCycle!: string | null;
}

export class PublicReceiptContentDto {
  @ApiProperty({ enum: [1] }) version!: 1;
  @ApiProperty() clinicName!: string;
  @ApiProperty() professionalName!: string;
  @ApiProperty({ format: 'uuid' }) settlementId!: string;
  @ApiProperty({ type: PublicReceiptPeriodDto })
  period!: PublicReceiptPeriodDto;
  @ApiProperty({ type: PublicReceiptPaymentDto })
  payment!: PublicReceiptPaymentDto;
  @ApiProperty({ type: [PublicReceiptLineDto] }) lines!: PublicReceiptLineDto[];
  @ApiProperty({ type: PublicReceiptFormatDto })
  format!: PublicReceiptFormatDto;
}

export class PublicCommissionReceiptDto {
  @ApiProperty({
    enum: ['PENDING', 'SIGNED'],
    enumName: 'PublicCommissionReceiptStatus',
  })
  status!: 'PENDING' | 'SIGNED';
  @ApiProperty({ type: PublicReceiptContentDto })
  content!: PublicReceiptContentDto;
  @ApiProperty({ format: 'date-time' }) expiresAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  signedAt!: Date | null;
  @ApiProperty({ type: String, nullable: true }) signerName!: string | null;
}
