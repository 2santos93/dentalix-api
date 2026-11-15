import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentProofPolicy, PaymentReportStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsISO4217CurrencyCode,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  IsPositiveMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';
import { CURRENCY_CODE_MESSAGE } from '../../../../shared/money/currency-messages';
import { MANUAL_RATE_MAX } from '../../../exchange/domain/exchange-rate-source';
import { PaymentDto } from '../../../payments/presentation/dto/payment.dto';
import { DocumentRegionalDto } from '../../../../shared/locations/document-regional.dto';
import {
  REJECT_REASON_MAX,
  REPORT_NOTE_MAX,
  REPORT_REFERENCE_MAX,
} from '../../domain/payment-link';

function toUpperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

const CIVIL_DAY = /^\d{4}-\d{2}-\d{2}$/;
const PAID_ON_MESSAGE =
  'La fecha del pago tiene que ser un día válido (AAAA-MM-DD).';

// --- crear el enlace --------------------------------------------------------

export class PaymentLinkTargetDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Plan cobrable del paciente. Exactamente uno de los dos.',
  })
  @IsOptional()
  @IsUUID()
  treatmentPlanId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Saldo migrado del paciente. Exactamente uno de los dos.',
  })
  @IsOptional()
  @IsUUID()
  openingBalanceId?: string;
}

export class CreatePaymentLinkDto {
  @ApiProperty({ type: PaymentLinkTargetDto })
  @ValidateNested()
  @Type(() => PaymentLinkTargetDto)
  target!: PaymentLinkTargetDto;

  @ApiProperty({
    example: 40,
    exclusiveMinimum: true,
    minimum: 0,
    maximum: MONEY_MAX,
    description:
      'Importe pedido, en la moneda del destino (la web lo prellena con la próxima cuota o con el saldo).',
  })
  @IsPositiveMoney()
  amount!: number;

  @ApiPropertyOptional({
    description:
      'Moneda del destino (ISO 4217). Si llega, tiene que ser la suya: 400 si no.',
  })
  @IsOptional()
  @Transform(toUpperCase)
  @IsISO4217CurrencyCode({ message: CURRENCY_CODE_MESSAGE })
  currency?: string;

  @ApiPropertyOptional({
    enum: ['EMAIL', 'WHATSAPP'],
    nullable: true,
    description:
      'EMAIL: lo envía por el outbox (plantilla `payment-link`; 422 sin email, 429 con el tope). WHATSAPP: devuelve `whatsapp` para wa.me (422 sin teléfono válido). Sin canal: solo la URL para copiarla.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn(['EMAIL', 'WHATSAPP'])
  channel?: 'EMAIL' | 'WHATSAPP' | null;
}

export class PaymentLinkWhatsAppDto {
  @ApiProperty({ description: 'Dígitos para wa.me (sin +).' })
  phone!: string;

  @ApiProperty({
    description: 'Texto del mensaje: saludo, clínica y enlace. Sin importes.',
  })
  text!: string;
}

const CONCEPT = {
  enum: ['INSTALLMENT', 'BALANCE'],
  description:
    'INSTALLMENT «Cuota del plan de pagos» (el plan tiene uno activo) o BALANCE «Saldo pendiente».',
};

export class CreatedPaymentLinkDto {
  @ApiProperty({ format: 'uuid' }) id!: string;

  @ApiProperty({
    description:
      'URL pública con el token. Solo viene en esta respuesta: el token no se guarda.',
  })
  url!: string;

  @ApiProperty({ format: 'date-time' }) expiresAt!: Date;
  @ApiProperty() amount!: number;
  @ApiProperty() currency!: string;
  @ApiProperty(CONCEPT) concept!: 'INSTALLMENT' | 'BALANCE';

  @ApiProperty({ enum: ['EMAIL', 'WHATSAPP'], nullable: true })
  channel!: 'EMAIL' | 'WHATSAPP' | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'EMAIL: el destino enmascarado (an***@dominio).',
  })
  emailSentTo!: string | null;

  @ApiProperty({ type: PaymentLinkWhatsAppDto, nullable: true })
  whatsapp!: PaymentLinkWhatsAppDto | null;

  @ApiProperty({
    description: 'Enlaces anteriores del mismo destino que se anularon.',
  })
  revokedPrevious!: number;
}

export class PaymentLinkReportRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: PaymentReportStatus, enumName: 'PaymentReportStatus' })
  status!: PaymentReportStatus;
}

export class PatientPaymentLinkDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  treatmentPlanId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  openingBalanceId!: string | null;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty() amount!: number;
  @ApiProperty() currency!: string;
  @ApiProperty(CONCEPT) concept!: 'INSTALLMENT' | 'BALANCE';
  @ApiProperty({ enum: ['EMAIL', 'WHATSAPP'], nullable: true })
  channel!: 'EMAIL' | 'WHATSAPP' | null;
  @ApiProperty({
    enum: ['LIVE', 'USED', 'EXPIRED', 'REVOKED'],
    description:
      'Derivado: USED (ya tiene reporte), REVOKED (otro enlace del mismo destino o el archivado), EXPIRED o LIVE.',
  })
  status!: 'LIVE' | 'USED' | 'EXPIRED' | 'REVOKED';
  @ApiProperty({ format: 'date-time' }) expiresAt!: Date;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'uuid' }) createdById!: string;
  @ApiProperty({ type: Date, nullable: true }) openedAt!: Date | null;
  @ApiProperty({ type: Date, nullable: true }) usedAt!: Date | null;
  @ApiProperty({ type: Date, nullable: true }) revokedAt!: Date | null;
  @ApiProperty({ type: PaymentLinkReportRefDto, nullable: true })
  report!: PaymentLinkReportRefDto | null;
}

// --- rutas públicas ---------------------------------------------------------

export class PublicClinicDto {
  @ApiProperty() name!: string;
  @ApiProperty() primaryColor!: string;
  @ApiProperty({ type: String, nullable: true }) logoUrl!: string | null;
}

export class PublicAmountDto {
  @ApiProperty() currency!: string;
  @ApiProperty() amount!: number;
}

export class PublicPaymentInstructionsDto {
  @ApiProperty({ type: String, nullable: true }) holderName!: string | null;
  @ApiProperty({ type: String, nullable: true }) holderId!: string | null;
  @ApiProperty({ type: String, nullable: true }) bankName!: string | null;
  @ApiProperty({ type: String, nullable: true }) accountNumber!: string | null;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({ type: String, nullable: true }) email!: string | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
}

export class PublicPaymentMethodDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() requiresReference!: boolean;
  @ApiProperty({ enum: PaymentProofPolicy, enumName: 'PaymentProofPolicy' })
  proofPolicy!: PaymentProofPolicy;
  @ApiProperty({ type: PublicPaymentInstructionsDto })
  instructions!: PublicPaymentInstructionsDto;
}

export class PublicStagedProofDto {
  @ApiProperty({ format: 'uuid' }) uploadId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() mime!: string;
  @ApiProperty() size!: number;
}

export class PublicPaymentLinkDto {
  @ApiProperty({ enum: ['LIVE'] }) status!: 'LIVE';
  @ApiProperty({ type: PublicClinicDto, nullable: true })
  clinic!: PublicClinicDto | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Solo el nombre de pila.',
  })
  patientFirstName!: string | null;
  @ApiProperty({
    type: DocumentRegionalDto,
    nullable: true,
    description:
      'DX-354: zona, locale y reloj de la sede del enlace, para pintar el importe, las equivalencias, `rateDate`, `expiresAt` y los límites de la fecha. null si a la sede le falta algo: la página pinta «—».',
  })
  regional!: DocumentRegionalDto | null;
  @ApiProperty(CONCEPT) concept!: 'INSTALLMENT' | 'BALANCE';
  @ApiProperty({
    description: 'Concepto genérico, sin nombres de tratamiento.',
  })
  conceptLabel!: string;
  @ApiProperty() amount!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({
    type: [PublicAmountDto],
    description:
      'El importe en las otras monedas de la clínica con la tasa de hoy YA guardada; vacío sin tasa.',
  })
  equivalents!: PublicAmountDto[];
  @ApiProperty({ type: String, nullable: true }) rateDate!: string | null;
  @ApiProperty({
    description:
      'Hay otras monedas y no tasa de hoy: «Consulta el importe en otra moneda con la clínica».',
  })
  equivalentsUnavailable!: boolean;
  @ApiProperty({
    type: [String],
    description: 'Monedas en que se puede reportar el pago.',
  })
  currencies!: string[];
  @ApiProperty({ type: [PublicPaymentMethodDto] })
  methods!: PublicPaymentMethodDto[];
  @ApiProperty({ format: 'date-time' }) expiresAt!: Date;
  @ApiProperty({ description: 'Primer día admitido para la fecha del pago.' })
  paidOnMin!: string;
  @ApiProperty({ description: 'Hoy en la sede: último día admitido.' })
  paidOnMax!: string;
  @ApiProperty({ type: PublicStagedProofDto, nullable: true })
  stagedProof!: PublicStagedProofDto | null;
  @ApiProperty({ description: 'Subidas de comprobante que quedan (de 3).' })
  proofUploadsLeft!: number;
}

export class CompletePaymentLinkProofDto {
  @ApiProperty({
    format: 'uuid',
    description: 'El `uploadId` de la autorización.',
  })
  @IsUUID('all', { message: 'La subida no es válida.' })
  uploadId!: string;
}

export class SubmitPaymentReportDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Uno de los medios que ofrece el enlace.',
  })
  @IsUUID('all', { message: 'Elige uno de los medios de pago del enlace.' })
  paymentMethodId!: string;

  @ApiProperty({ description: 'Una de las monedas que cobra la clínica.' })
  @Transform(toUpperCase)
  @IsISO4217CurrencyCode({ message: CURRENCY_CODE_MESSAGE })
  currency!: string;

  @ApiProperty({ exclusiveMinimum: true, minimum: 0, maximum: MONEY_MAX })
  @IsPositiveMoney()
  amount!: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: REPORT_REFERENCE_MAX,
    description: 'Obligatoria si el medio la pide.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(REPORT_REFERENCE_MAX * 2)
  reference?: string | null;

  @ApiProperty({
    example: '2026-11-14',
    description:
      'Día del pago: desde el día del enlace menos 2 hasta hoy, en la sede.',
  })
  @IsString({ message: PAID_ON_MESSAGE })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && CIVIL_DAY.test(value.trim())
      ? value.trim()
      : value,
  )
  paidOn!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'El comprobante subido y completado con este enlace; obligatorio si el medio lo exige.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID('all', { message: 'La subida no es válida.' })
  proofUploadId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: REPORT_NOTE_MAX,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(REPORT_NOTE_MAX * 2)
  note?: string | null;
}

export class PaymentReportedDto {
  @ApiProperty({ enum: ['REPORTED'] }) status!: 'REPORTED';
  @ApiProperty() message!: string;
}

// --- bandeja ----------------------------------------------------------------

export const PAYMENT_REPORTS_MAX_PAGE_SIZE = 100;

export class ListPaymentReportsQueryDto {
  @ApiPropertyOptional({
    enum: PaymentReportStatus,
    enumName: 'PaymentReportStatus',
    description: 'Sin indicarlo, todos.',
  })
  @IsOptional()
  @IsEnum(PaymentReportStatus)
  status?: PaymentReportStatus;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: PAYMENT_REPORTS_MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAYMENT_REPORTS_MAX_PAGE_SIZE)
  pageSize?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sede del enlace (la del plan). Sin ella, la de la cabecera o las permitidas, como Caja.',
  })
  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class CountPaymentReportsQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class PaymentReportProofDto {
  @ApiProperty() name!: string;
  @ApiProperty() mime!: string;
  @ApiProperty() size!: number;
}

export class PaymentReportLinkDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  treatmentPlanId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  openingBalanceId!: string | null;
  @ApiProperty({ description: 'Lo que se pidió.' }) amount!: number;
  @ApiProperty() currency!: string;
  @ApiProperty(CONCEPT) concept!: 'INSTALLMENT' | 'BALANCE';
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
}

export class PaymentReportDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: PaymentReportStatus, enumName: 'PaymentReportStatus' })
  status!: PaymentReportStatus;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'uuid' }) patientId!: string;
  @ApiProperty() patientName!: string;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty({ format: 'uuid' }) paymentMethodId!: string;
  @ApiProperty() paymentMethodName!: string;
  @ApiProperty() amount!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ type: String, nullable: true }) reference!: string | null;
  @ApiProperty({ description: 'Día civil del pago (AAAA-MM-DD).' })
  paidOn!: string;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({
    type: PaymentReportProofDto,
    nullable: true,
    description:
      'Metadatos del comprobante; se ve con GET /payment-reports/:id/proof-url.',
  })
  proof!: PaymentReportProofDto | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  paymentId!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Motivo interno del rechazo (nunca se envía al paciente).',
  })
  rejectReason!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  decidedById!: string | null;
  @ApiProperty({ type: Date, nullable: true }) decidedAt!: Date | null;
  @ApiProperty({ type: PaymentReportLinkDto }) link!: PaymentReportLinkDto;
}

export class PaymentReportsPageDto {
  @ApiProperty({ type: [PaymentReportDto] }) items!: PaymentReportDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

export class PaymentReportsCountDto {
  @ApiProperty() pending!: number;
}

export class PaymentReportProofUrlDto {
  @ApiProperty() url!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty() mime!: string;
  @ApiProperty() name!: string;
}

export class ConfirmPaymentReportDto {
  @ApiPropertyOptional({
    exclusiveMinimum: true,
    minimum: 0,
    maximum: MONEY_MAX,
    description: 'Corrección: lo que llegó de verdad.',
  })
  @IsOptional()
  @IsPositiveMoney()
  amount?: number;

  @ApiPropertyOptional({ description: 'Corrección de la moneda.' })
  @IsOptional()
  @Transform(toUpperCase)
  @IsISO4217CurrencyCode({ message: CURRENCY_CODE_MESSAGE })
  currency?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Corrección del medio (de la clínica y activo).',
  })
  @IsOptional()
  @IsUUID()
  paymentMethodId?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Corrección de la referencia; null o vacío la quita.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(REPORT_REFERENCE_MAX * 2)
  reference?: string | null;

  @ApiPropertyOptional({
    example: '2026-11-14',
    description:
      'Corrección del día del pago (AAAA-MM-DD); la tasa es la de ese día.',
  })
  @IsOptional()
  @IsString({ message: PAID_ON_MESSAGE })
  paidOn?: string;

  @ApiPropertyOptional({
    exclusiveMinimum: true,
    minimum: 0,
    maximum: MANUAL_RATE_MAX,
    description:
      'Tasa que fija recepción: unidades de la moneda que no es USD por 1 USD (una de las dos tiene que ser USD). Exige `rateOverrideReason`.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @IsPositive()
  @Max(MANUAL_RATE_MAX)
  rateOverride?: number;

  @ApiPropertyOptional({ maxLength: 280 })
  @IsOptional()
  @IsString()
  @MaxLength(560)
  rateOverrideReason?: string;

  @ApiPropertyOptional({
    description:
      'Motivo para confirmar una referencia repetida (409 PAYMENT_REFERENCE_DUPLICATE sin él).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  duplicateReferenceReason?: string;
}

export class ConfirmedPaymentReportDto {
  @ApiProperty({ format: 'uuid' }) reportId!: string;
  @ApiProperty({ enum: ['CONFIRMED'] }) status!: 'CONFIRMED';
  @ApiProperty({ type: PaymentDto }) payment!: PaymentDto;
}

export class RejectPaymentReportDto {
  @ApiProperty({
    minLength: 1,
    maxLength: REJECT_REASON_MAX,
    description: 'Motivo interno (no se envía al paciente).',
  })
  @IsString({
    message: `Escribe el motivo (hasta ${REJECT_REASON_MAX} caracteres).`,
  })
  @MaxLength(REJECT_REASON_MAX * 2)
  reason!: string;
}

export class RejectedPaymentReportDto {
  @ApiProperty({ type: PaymentReportDto }) report!: PaymentReportDto;
  @ApiProperty({
    description: 'Se encoló el aviso al email del paciente (sin el motivo).',
  })
  patientNotified!: boolean;
}
