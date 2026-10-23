import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DocType, PaymentMethod } from '@prisma/client';

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
    description: 'NIT/NIF (DX-019).',
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

  @ApiProperty({ enum: DocType })
  docType!: DocType;

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

  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ enum: PaymentMethod, nullable: true })
  method!: PaymentMethod | null;

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
  @ApiProperty({ example: 'COP' })
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

export class ReceiptSnapshotDto {
  @ApiProperty({ enum: [1] })
  version!: 1;

  @ApiProperty({ type: ReceiptClinicDto })
  clinic!: ReceiptClinicDto;

  @ApiProperty({ type: ReceiptLocationDto })
  location!: ReceiptLocationDto;

  @ApiProperty({
    description:
      'Falta la razón social o el NIT/NIF: el recibo dice «Datos fiscales pendientes».',
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
      'Saldo del plan tras el abono (moneda del plan); null si no se pudo calcular.',
  })
  planBalance!: ReceiptPlanBalanceDto | null;

  @ApiProperty({
    type: ReceiptCashierDto,
    nullable: true,
    description: 'Quién cobró.',
  })
  cashier!: ReceiptCashierDto | null;

  @ApiProperty({ example: 'Este documento no es factura' })
  legalNotice!: string;
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
