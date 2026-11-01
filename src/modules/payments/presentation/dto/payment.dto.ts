import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import {
  PAYMENT_EXCHANGE_RATE_STATUSES,
  type PaymentExchangeRateStatus,
} from '../../domain/payment-exchange-rate';
import {
  EXCHANGE_RATE_STATUS_DESCRIPTION,
  FrozenExchangeRateDto,
} from './frozen-exchange-rate.dto';

// Response shape for Payment endpoints -- documents the Payment entity
// contract for Swagger (same convention as AppointmentDto / SaleDto: exists
// purely for `@ApiProperty` docs, not input validation). The use cases
// already return values shaped exactly like this (Payment entity, see
// ../../domain/entities/payment.entity.ts).
export class PaymentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Plan del abono; null si es contra un saldo migrado (DX-262)',
  })
  treatmentPlanId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Saldo migrado del abono (DX-262); null si es a un plan',
  })
  openingBalanceId!: string | null;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ example: 100 })
  amount!: number;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({ format: 'date-time' })
  paidAt!: Date;

  @ApiProperty({
    example: '2026-10-16',
    description:
      'Día civil (YYYY-MM-DD) del pago en la zona IANA de la sede del abono ' +
      '(DX-097). Es el día que se muestra y el de la tasa de cambio.',
  })
  paidOn!: string;

  @ApiProperty({
    enum: PaymentMethod,
    nullable: true,
    description:
      'Método antiguo, derivado del tipo base del medio (DX-377: DIGITAL se ' +
      'guarda como TRANSFER). Se mantiene para informes y réplicas anteriores.',
  })
  method!: PaymentMethod | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Medio de pago del catálogo de la clínica (DX-377).',
  })
  paymentMethodId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Pago móvil' })
  paymentMethodName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Referencia del pago tal como la dio el pagador (DX-377).',
  })
  reference!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-515: nº de la factura fiscal emitida fuera de Dentalix (texto libre); null si no se anotó.',
  })
  externalInvoiceNumber!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Motivo con que se confirmó una referencia repetida (DX-377); null si no se repetía.',
  })
  duplicateReferenceReason!: string | null;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Solo en la respuesta del alta: ids de los abonos con la misma referencia y medio que se confirmaron con motivo.',
  })
  duplicateReferenceOf?: string[];

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'DX-390: el cobro dividido del abono (el id de su línea 1, que lleva el ' +
      'recibo único); null en un abono de una sola forma de pago.',
  })
  splitId!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 5,
    description: 'DX-390: número de la línea en su cobro dividido (1–5).',
  })
  splitLine!: number | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'NOR-000123',
    description:
      'Número del recibo de caja (DX-136): serie de la sede y consecutivo. ' +
      'null en los abonos anteriores a la numeración («sin serie»; su ' +
      'recibo conserva la referencia antigua REC-xxxxxxxx). DX-390: todas ' +
      'las líneas de un cobro dividido llevan el número de su recibo único.',
  })
  receiptNumber!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-375: moneda a la que convierte la tasa del abono (la del plan o la ' +
      'del saldo migrado); null en un abono anterior a la tasa congelada aún ' +
      'sin congelar.',
  })
  exchangeRateCurrency!: string | null;

  @ApiProperty({
    type: FrozenExchangeRateDto,
    nullable: true,
    description:
      'DX-375: la tasa que congeló el abono; null en su misma moneda, «sin ' +
      'tasa» o anterior aún sin congelar.',
  })
  frozenRate!: FrozenExchangeRateDto | null;

  @ApiProperty({
    enum: PAYMENT_EXCHANGE_RATE_STATUSES,
    enumName: 'PaymentExchangeRateStatus',
    description: EXCHANGE_RATE_STATUS_DESCRIPTION,
  })
  exchangeRateStatus!: PaymentExchangeRateStatus;
}
