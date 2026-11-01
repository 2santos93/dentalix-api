import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, type DocumentType } from '@prisma/client';
import { DOCUMENT_TYPES } from '../../../patients/domain/document-type';
import {
  DOC_TYPE_LABEL_PROPERTY,
  DOC_TYPE_NAME_DESCRIPTION,
} from '../../../patients/presentation/dto/doc-type-input';
import { FrozenExchangeRateDto } from './frozen-exchange-rate.dto';

// Respuesta de GET /payments/:id/receipt y POST /payments/:id/receipt/print
// (DX-136). Solo documenta el contrato para Swagger: el caso de uso ya
// devuelve exactamente esta forma (PaymentReceiptView).

export class ReceiptClinicDto {
  @ApiProperty({ example: 'Clínica Demo' })
  name!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Razón social (DX-019).',
  })
  legalName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Identificador fiscal de la clínica (DX-019).',
  })
  taxId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  address!: string | null;
}

export class ReceiptLocationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sede Norte' })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  address!: string | null;
}

export class ReceiptPatientDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Carolina Duque' })
  fullName!: string;

  @ApiProperty({ enum: DOCUMENT_TYPES, enumName: 'DocType' })
  docType!: DocumentType;

  @ApiProperty(DOC_TYPE_LABEL_PROPERTY)
  docTypeLabel!: string | null;

  @ApiProperty({
    description:
      `${DOC_TYPE_NAME_DESCRIPTION} Congelado al emitir el recibo; en los ` +
      'recibos anteriores, el nombre local de hoy o el genérico.',
  })
  docTypeName!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '******5678',
    description: 'Documento enmascarado: nunca se guarda ni se sirve en claro.',
  })
  docNumberMasked!: string | null;
}

export class ReceiptPaymentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 150000 })
  amount!: number;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({ enum: PaymentMethod, nullable: true })
  method!: PaymentMethod | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'DX-377: nombre del medio de pago; ausente en los recibos anteriores.',
  })
  paymentMethodName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'DX-377: referencia del pago; ausente en los recibos anteriores.',
  })
  reference?: string | null;

  @ApiProperty({ format: 'date-time' })
  paidAt!: string;

  @ApiProperty({ example: '2026-10-17', description: 'Día civil en la sede.' })
  paidOn!: string;
}

export class ReceiptPlanDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Opción A: implante' })
  optionLabel!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class ReceiptOpeningBalanceDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Saldo migrado' })
  concept!: string;

  @ApiProperty({ example: '2026-03-15', description: 'Fecha de corte' })
  asOfDate!: string;
}

export class ReceiptPlanBalanceDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({ example: 900000 })
  billable!: number;

  @ApiProperty({ example: 450000 })
  paid!: number;

  @ApiProperty({ example: 450000 })
  balance!: number;
}

export class ReceiptCashierDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Recepción Demo' })
  fullName!: string;
}

/** DX-390: una forma de pago del cobro dividido en la foto del recibo. */
export class ReceiptSplitLineDto {
  @ApiProperty({ format: 'uuid', description: 'El abono de la línea.' })
  paymentId!: string;

  @ApiProperty({ minimum: 1, maximum: 5 })
  line!: number;

  @ApiProperty({ example: 50 })
  amount!: number;

  @ApiProperty({ description: 'Código ISO 4217 de la línea.' })
  currency!: string;

  @ApiProperty({ enum: PaymentMethod, nullable: true })
  method!: PaymentMethod | null;

  @ApiProperty({ type: String, nullable: true })
  paymentMethodName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  reference!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'La línea en la moneda del plan con su tasa congelada; null «sin tasa».',
  })
  equivalentAmount!: number | null;
}

/** DX-390: total del cobro dividido en la moneda del plan. */
export class ReceiptSplitTotalDto {
  @ApiProperty({ description: 'Moneda del plan.' })
  currency!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'null si alguna línea está «sin tasa».',
  })
  amount!: number | null;
}

/** DX-390: el cobro dividido en la foto del recibo. */
export class ReceiptSnapshotSplitDto {
  @ApiProperty({ type: [ReceiptSplitLineDto] })
  lines!: ReceiptSplitLineDto[];

  @ApiProperty({ type: ReceiptSplitTotalDto })
  total!: ReceiptSplitTotalDto;
}

export class ReceiptSnapshotDto {
  @ApiProperty({ enum: [1] })
  version!: 1;

  @ApiProperty({ type: ReceiptClinicDto })
  clinic!: ReceiptClinicDto;

  @ApiProperty({ type: ReceiptLocationDto })
  location!: ReceiptLocationDto;

  @ApiProperty({
    description:
      'Falta la razón social o el identificador fiscal: el recibo dice «Datos fiscales pendientes».',
  })
  fiscalDataPending!: boolean;

  @ApiProperty({ type: ReceiptPatientDto })
  patient!: ReceiptPatientDto;

  @ApiProperty({ type: ReceiptPaymentDto })
  payment!: ReceiptPaymentDto;

  @ApiProperty({
    type: ReceiptPlanDto,
    nullable: true,
    description: 'null si el abono es contra un saldo migrado (DX-262)',
  })
  plan!: ReceiptPlanDto | null;

  @ApiPropertyOptional({
    type: ReceiptOpeningBalanceDto,
    nullable: true,
    description:
      'DX-262: saldo migrado del abono (concepto y fecha de corte); ausente o null si es a un plan',
  })
  openingBalance?: ReceiptOpeningBalanceDto | null;

  @ApiProperty({
    type: ReceiptPlanBalanceDto,
    nullable: true,
    description:
      'Saldo tras el abono: el del plan (en su moneda) o, si el abono va a un saldo migrado (DX-262), lo que queda pendiente de ese saldo; null si no se pudo calcular.',
  })
  planBalance!: ReceiptPlanBalanceDto | null;

  @ApiProperty({
    type: ReceiptCashierDto,
    nullable: true,
    description: 'Quién cobró.',
  })
  cashier!: ReceiptCashierDto | null;

  @ApiPropertyOptional({
    type: ReceiptSnapshotSplitDto,
    nullable: true,
    description:
      'DX-390: las formas de pago del cobro dividido y su total al emitir; ausente o null en un abono suelto (`payment` es entonces su línea 1).',
  })
  split?: ReceiptSnapshotSplitDto | null;

  @ApiProperty({ example: 'Este documento no es factura' })
  legalNotice!: string;

  @ApiPropertyOptional({
    example: 'Recibo de pago',
    description:
      'DX-515: el título del recibo que configuró la clínica, congelado al ' +
      'emitir. Ausente si no tenía (se imprime «Recibo de caja»).',
  })
  title?: string;

  @ApiPropertyOptional({
    example: 'Este recibo no es una factura',
    description:
      'DX-515: la leyenda de la clínica o de la sede, congelada al emitir. ' +
      'Ausente si no había: no se imprime nada, también al reimprimir un ' +
      'recibo anterior a que se configurara.',
  })
  legend?: string;
}

/**
 * DX-376: la tasa del abono para el recibo. Sale de la tasa que congeló el
 * abono (DX-375), no de la de hoy: reimprimir da siempre la misma.
 */
export class ReceiptExchangeRateDto {
  @ApiProperty({
    enum: ['FROZEN', 'MISSING', 'LEGACY'],
    enumName: 'ReceiptExchangeRateStatus',
    description:
      'FROZEN: congeló su tasa (rate y equivalentAmount presentes). MISSING: «sin tasa» de su día. LEGACY: anterior a la tasa congelada y aún sin congelar.',
  })
  status!: 'FROZEN' | 'MISSING' | 'LEGACY';

  @ApiProperty({
    type: FrozenExchangeRateDto,
    nullable: true,
    description:
      'La tasa congelada (moneda de destino, fuente y día); null si no la congeló.',
  })
  rate!: FrozenExchangeRateDto | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 50,
    description:
      'El abono en la moneda de destino (`rate.currency`) con la tasa congelada, redondeado a céntimos; null sin tasa.',
  })
  equivalentAmount!: number | null;
}

/** DX-390: una forma de pago del recibo, con su tasa congelada de hoy. */
export class ReceiptSplitViewLineDto extends ReceiptSplitLineDto {
  @ApiProperty({
    type: ReceiptExchangeRateDto,
    nullable: true,
    description: 'Como `exchangeRate` del recibo, para esta línea.',
  })
  exchangeRate!: ReceiptExchangeRateDto | null;
}

/** DX-390: las formas de pago del recibo y su total con las tasas de hoy. */
export class ReceiptSplitDto {
  @ApiProperty({ type: [ReceiptSplitViewLineDto] })
  lines!: ReceiptSplitViewLineDto[];

  @ApiProperty({ type: ReceiptSplitTotalDto })
  total!: ReceiptSplitTotalDto;
}

export class PaymentReceiptDto {
  @ApiProperty({ format: 'uuid' })
  paymentId!: string;

  @ApiProperty({
    example: 'NOR-000123',
    description:
      'Número del recibo, o la referencia antigua REC-xxxxxxxx si es «sin serie».',
  })
  reference!: string;

  @ApiProperty({ type: String, nullable: true, example: 'NOR' })
  seriesPrefix!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 123 })
  number!: number | null;

  @ApiProperty({
    description: 'Abono anterior a la numeración consecutiva («sin serie»).',
  })
  legacy!: boolean;

  @ApiProperty({ format: 'date-time' })
  issuedAt!: Date;

  @ApiProperty()
  voided!: boolean;

  @ApiProperty({ type: Date, nullable: true })
  voidedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  voidReason!: string | null;

  @ApiProperty({
    type: ReceiptExchangeRateDto,
    nullable: true,
    description:
      'DX-376: la tasa del abono y su equivalente en la moneda de su destino; null si el abono está en esa moneda o es un cobro dividido (DX-390: cada línea lleva la suya en `split`).',
  })
  exchangeRate!: ReceiptExchangeRateDto | null;

  @ApiProperty({
    type: ReceiptSplitDto,
    nullable: true,
    description:
      'DX-390: el cobro dividido del recibo (todas sus formas de pago, cada una con su tasa congelada, y el total en la moneda del plan); null en un abono suelto. El recibo de cualquier línea es el del cobro.',
  })
  split!: ReceiptSplitDto | null;

  @ApiProperty({
    type: ReceiptSnapshotDto,
    description:
      'Foto inmutable al emitir (en los «sin serie», los datos de hoy).',
  })
  snapshot!: ReceiptSnapshotDto;
}

export class SendPaymentReceiptResponseDto {
  @ApiProperty({
    example: 'an***@example.com',
    description: 'Destino enmascarado.',
  })
  sentTo!: string;

  @ApiProperty({
    description:
      'DX-203: salió al email del responsable (un menor o un paciente sin email).',
  })
  sentToResponsible!: boolean;
}
