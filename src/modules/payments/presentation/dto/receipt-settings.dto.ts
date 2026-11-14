import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import {
  EXTERNAL_INVOICE_NUMBER_MAX,
  RECEIPT_LEGEND_MAX,
  RECEIPT_TITLE_MAX,
} from '../../domain/receipt-settings';

const TITLE_DOC =
  `Título del recibo de caja, hasta ${RECEIPT_TITLE_MAX} caracteres en una ` +
  'línea. null o vacío = sin título propio (la web imprime «Recibo de caja»).';
const LEGEND_DOC =
  `Leyenda del recibo, hasta ${RECEIPT_LEGEND_MAX} caracteres en una línea. ` +
  'null o vacío = no se imprime ninguna.';

/** DX-515: `PUT /payment-receipts/settings` y su respuesta. */
export class ReceiptSettingsDto {
  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: RECEIPT_TITLE_MAX,
    example: 'Recibo de pago',
    description: TITLE_DOC,
  })
  @IsOptional()
  @IsString({ message: 'El título del recibo debe ser un texto.' })
  title!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: RECEIPT_LEGEND_MAX,
    example: 'Este recibo no es una factura',
    description: LEGEND_DOC,
  })
  @IsOptional()
  @IsString({ message: 'La leyenda del recibo debe ser un texto.' })
  legend!: string | null;
}

/** DX-515: `PUT /payment-receipts/settings/locations/:locationId`. */
export class LocationReceiptLegendDto {
  @ApiProperty({
    description:
      'true = la sede imprime SU leyenda (`legend`; vacía = ninguna) en vez de la de la clínica. false = usa la de la clínica.',
  })
  @IsBoolean({ message: '«Leyenda propia de la sede» debe ser sí o no.' })
  override!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    maxLength: RECEIPT_LEGEND_MAX,
    description: `${LEGEND_DOC} Se ignora con override false.`,
  })
  @IsOptional()
  @IsString({ message: 'La leyenda del recibo debe ser un texto.' })
  legend?: string | null;
}

export class LocationReceiptLegendViewDto {
  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ example: 'Sede Norte' })
  name!: string;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({
    description: 'La sede usa su propia leyenda (aunque sea ninguna).',
  })
  override!: boolean;

  @ApiProperty({ type: String, nullable: true })
  legend!: string | null;
}

/** DX-515: `GET /payment-receipts/settings`. */
export class ReceiptSettingsViewDto extends ReceiptSettingsDto {
  @ApiProperty({ type: [LocationReceiptLegendViewDto] })
  locations!: LocationReceiptLegendViewDto[];
}

/** DX-515: `PUT /payments/:id/external-invoice-number`. */
export class ExternalInvoiceNumberDto {
  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: EXTERNAL_INVOICE_NUMBER_MAX,
    example: '00-000123',
    description:
      `Nº de la factura fiscal emitida fuera de Dentalix, texto libre sin ` +
      `formato, hasta ${EXTERNAL_INVOICE_NUMBER_MAX} caracteres en una línea. ` +
      'null o vacío lo quita.',
  })
  @IsOptional()
  @IsString({ message: 'El nº de factura externa debe ser un texto.' })
  externalInvoiceNumber!: string | null;
}

export class ExternalInvoiceNumberResultDto {
  @ApiProperty({ format: 'uuid' })
  paymentId!: string;

  @ApiProperty({ type: String, nullable: true })
  externalInvoiceNumber!: string | null;

  @ApiProperty({
    type: [String],
    description:
      'Los abonos que lo llevan: el pedido o, en un cobro dividido, todas sus líneas.',
  })
  paymentIds!: string[];
}
