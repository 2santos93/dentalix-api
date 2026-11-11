import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import {
  RECEIPT_SUMMARY_MAX_DAYS,
  RECEIPT_SUMMARY_NOTICE,
} from '../../domain/receipt-summary';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';
import { ReceiptClinicDto } from './payment-receipt.dto';

// DX-401: contrato de `GET/POST /patients/:patientId/payment-receipts/summary`.
// Solo documenta para Swagger: el caso de uso ya devuelve esta forma
// (PaymentReceiptSummaryView).

/**
 * `from`/`to`: días civiles, AMBOS inclusive, en la zona de la sede de cada
 * recibo (DX-097, como la caja). El DTO solo comprueba la forma; que el día
 * exista, el orden, el rango admitido y el tope los valida el caso de uso.
 */
export class PaymentReceiptSummaryQueryDto {
  @ApiProperty({
    example: '2026-10-01',
    description:
      'Primer día del período (AAAA-MM-DD), inclusive, en la zona horaria de la sede de cada recibo.',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'from debe ser una fecha AAAA-MM-DD.',
  })
  from!: string;

  @ApiProperty({
    example: '2026-10-31',
    description:
      `Último día del período (AAAA-MM-DD), inclusive. Debe ser >= from; el ` +
      `período no puede superar ${RECEIPT_SUMMARY_MAX_DAYS} días. Las dos ` +
      `fechas, entre ${PERIOD_DAY_MIN} y ${PERIOD_DAY_MAX} (400 si no).`,
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'to debe ser una fecha AAAA-MM-DD.',
  })
  to!: string;
}

export class ReceiptSummaryPatientDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'María Fernanda Rondón' })
  fullName!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '****5678',
    description:
      'Número del documento enmascarado como en el recibo (nunca en claro); null sin documento.',
  })
  documentMasked!: string | null;

  @ApiProperty({
    example: 'Documento nacional',
    description:
      'Nombre visible del tipo de documento (DX-327), con los nombres de la clínica.',
  })
  documentTypeName!: string;

  @ApiProperty({
    example: '1042',
    description: 'Código del paciente (DX-484).',
  })
  patientCode!: string;
}

export class ReceiptSummaryLineDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'El abono del recibo (en un cobro dividido, el de su línea 1): `GET /payments/:id/receipt`.',
  })
  paymentId!: string;

  @ApiProperty({
    example: 'CCS-000123',
    description:
      'Número del recibo (serie y consecutivo), o `REC-xxxxxxxx` en un abono anterior a la numeración. Se repite en cada forma de pago de un cobro dividido.',
  })
  receiptNumber!: string;

  @ApiProperty({
    example: '2026-10-15',
    description: 'Día civil de emisión en la zona de la sede del recibo.',
  })
  issuedOn!: string;

  @ApiProperty({
    example: 'Sede Altamira',
    description: 'Sede del recibo (la de su foto).',
  })
  locationName!: string;

  @ApiProperty({
    example: 'Pago móvil',
    description:
      'Medio de pago de la clínica o, sin él, el método (Efectivo, Tarjeta…).',
  })
  methodLabel!: string;

  @ApiProperty({ example: 150, description: 'Importe en su moneda.' })
  amount!: number;

  @ApiProperty({ description: 'Código ISO 4217 de la moneda del importe.' })
  currency!: string;

  @ApiProperty({ description: 'Recibo anulado: no suma en los totales.' })
  voided!: boolean;

  @ApiProperty({ type: String, nullable: true })
  voidReason!: string | null;
}

export class ReceiptSummaryTotalDto {
  @ApiProperty({ description: 'Código ISO 4217.' })
  currency!: string;

  @ApiProperty({ example: 150 })
  amount!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    description: 'Formas de pago no anuladas en esa moneda.',
  })
  count!: number;
}

export class PaymentReceiptSummaryDto {
  @ApiProperty({ type: ReceiptSummaryPatientDto })
  patient!: ReceiptSummaryPatientDto;

  @ApiProperty({
    type: ReceiptClinicDto,
    description: 'Datos de HOY de la clínica (el resumen se emite hoy).',
  })
  clinic!: ReceiptClinicDto;

  @ApiProperty({ example: '2026-10-01' })
  from!: string;

  @ApiProperty({ example: '2026-10-31' })
  to!: string;

  @ApiProperty({ format: 'date-time' })
  generatedAt!: string;

  @ApiProperty({
    description:
      'DX-525: quien consulta solo ve sus sedes; los recibos de las demás no salen.',
  })
  restrictedToLocations!: boolean;

  @ApiProperty({
    type: [ReceiptSummaryLineDto],
    description:
      'Una fila por forma de pago, en orden de emisión; vacía si no hay recibos.',
  })
  receipts!: ReceiptSummaryLineDto[];

  @ApiProperty({
    type: [ReceiptSummaryTotalDto],
    description:
      'Total por moneda de lo NO anulado (las monedas nunca se suman entre sí).',
  })
  totals!: ReceiptSummaryTotalDto[];

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Recibos anulados.',
  })
  voidedCount!: number;

  @ApiProperty({ example: RECEIPT_SUMMARY_NOTICE })
  notice!: string;
}
