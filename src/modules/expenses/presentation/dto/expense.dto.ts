import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';

/** El soporte tal como lo ve la API: la clave del almacén no sale nunca. */
export class ExpenseAttachmentDto {
  @ApiProperty({ example: 'factura-luz.pdf' })
  name!: string;

  @ApiProperty({ example: 'application/pdf' })
  mimeType!: string;

  @ApiProperty()
  sizeBytes!: number;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  sha256!: string;
}

export class ExpensePaymentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 150000 }) amount!: number;
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;
  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  method!: PaymentMethod;
  @ApiProperty({ format: 'date', example: '2026-10-23' }) paidOn!: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'La caja de la que salió el efectivo (salida de caja).',
  })
  cashSessionId!: string | null;
  @ApiProperty({ format: 'uuid' }) createdById!: string;
  @ApiProperty({ type: String, nullable: true }) createdByName!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  voidedAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) voidedById!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) voidedByName!: string | null;
  @ApiProperty({ type: String, nullable: true }) voidReason!: string | null;
}

export class ExpenseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty({
    example: 'Servicios públicos',
    description: 'Foto del nombre al crear o editar.',
  })
  category!: string;
  @ApiProperty({ type: String, nullable: true }) supplier!: string | null;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ example: 150000 }) amount!: number;
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;
  @ApiProperty({ format: 'date', example: '2026-10-20' }) invoiceDate!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true }) dueDate!:
    string | null;
  @ApiProperty({ description: 'Σ de los pagos vivos.' }) paidAmount!: number;
  @ApiProperty({ description: 'Lo que falta por pagar (0 si está anulado).' })
  pendingAmount!: number;
  @ApiProperty({
    enum: ['PENDING', 'PARTIAL', 'PAID', 'VOIDED'],
    description: 'Derivado de los pagos vivos y la anulación.',
  })
  status!: 'PENDING' | 'PARTIAL' | 'PAID' | 'VOIDED';
  @ApiProperty({
    description: 'No pagado del todo y con el vencimiento ya pasado.',
  })
  overdue!: boolean;
  @ApiProperty({ type: ExpenseAttachmentDto, nullable: true })
  attachment!: ExpenseAttachmentDto | null;
  @ApiProperty({ format: 'uuid' }) createdById!: string;
  @ApiProperty({ type: String, nullable: true }) createdByName!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  voidedAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) voidedById!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) voidedByName!: string | null;
  @ApiProperty({ type: String, nullable: true }) voidReason!: string | null;
}

export class ExpenseDetailDto extends ExpenseDto {
  @ApiProperty({ type: [ExpensePaymentDto] })
  payments!: ExpensePaymentDto[];
}

export class ExpensePageDto {
  @ApiProperty({ type: [ExpenseDto] }) items!: ExpenseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

export class ExpenseReceiptTargetDto {
  @ApiProperty({ enum: ['POST'] }) method!: 'POST';
  @ApiProperty({
    description:
      'Adónde se envía el formulario: el bucket (S3) o la API (disco, en desarrollo)',
  })
  url!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'Campos del formulario, en este orden y ANTES del fichero, que va al final en el campo `file`',
  })
  fields!: Record<string, string>;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class ExpenseReceiptUploadDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Se entrega con el alta (`attachmentUploadId`) o a `POST /expenses/:id/attachment`',
  })
  uploadId!: string;
  @ApiProperty({ type: ExpenseReceiptTargetDto })
  target!: ExpenseReceiptTargetDto;
  @ApiProperty({ description: 'Tamaño máximo en bytes' }) maxBytes!: number;
}

export class ExpenseReceiptUrlDto {
  @ApiProperty() url!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ enum: ['inline', 'attachment'] })
  disposition!: 'inline' | 'attachment';
}

export class ExpenseCategoryDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null en las predefinidas (son constantes, no filas).',
  })
  id!: string | null;
  @ApiProperty({ example: 'Papelería' }) name!: string;
  @ApiProperty() predefined!: boolean;
}

export class ExpenseSummaryCategoryDto {
  @ApiProperty({ example: 'Alquiler' }) category!: string;
  @ApiProperty({ example: 2500000 }) amount!: number;
}

export class ExpenseSummaryRowDto {
  @ApiProperty({ example: '2026-10', description: 'Mes AAAA-MM.' })
  month!: string;
  @ApiProperty({ format: 'uuid' }) locationId!: string;
  @ApiProperty() locationName!: string;
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;
  @ApiProperty({
    description: 'Abonos vivos del mes civil de la sede, sin anulados.',
  })
  income!: number;
  @ApiProperty({
    type: [ExpenseSummaryCategoryDto],
    description: 'Gastos no anulados por fecha de factura; mayor primero.',
  })
  categories!: ExpenseSummaryCategoryDto[];
  @ApiProperty() expensesTotal!: number;
  @ApiProperty({ description: 'Ingresos − gastos; puede ser negativo.' })
  net!: number;
}

export class ExpenseSummaryDto {
  @ApiProperty({ format: 'date' }) from!: string;
  @ApiProperty({ format: 'date' }) to!: string;
  @ApiProperty({
    type: [ExpenseSummaryRowDto],
    description: 'Por mes, sede y moneda; las monedas nunca se mezclan.',
  })
  rows!: ExpenseSummaryRowDto[];
}

/** DX-411: lo que se debe en una moneda, por tramos de vencimiento. */
export class PayableAmountsDto {
  @ApiProperty({ description: 'Gastos abiertos (pendientes o parciales).' })
  openCount!: number;
  @ApiProperty({ description: 'Importe − pagos vivos de los gastos abiertos.' })
  pending!: number;
  @ApiProperty() overdueCount!: number;
  @ApiProperty({
    description: 'Pendiente con vencimiento anterior a hoy en su sede.',
  })
  overdue!: number;
  @ApiProperty() dueIn7DaysCount!: number;
  @ApiProperty({
    description: 'Pendiente que vence entre hoy y hoy + 6 días (su sede).',
  })
  dueIn7Days!: number;
  @ApiProperty() dueIn30DaysCount!: number;
  @ApiProperty({
    description:
      'Pendiente que vence entre hoy y hoy + 29 días (incluye el de 7 días).',
  })
  dueIn30Days!: number;
  @ApiProperty() noDueDateCount!: number;
  @ApiProperty({
    description: 'Pendiente sin vencimiento: nunca vencido ni en 7/30 días.',
  })
  noDueDate!: number;
}

export class PayableSupplierRowDto extends PayableAmountsDto {
  @ApiProperty({
    description:
      'Proveedor normalizado (sin espacios de más, mayúsculas ni tildes); vacío = sin proveedor. Va a `GET /expenses/payables/expenses`.',
  })
  supplierKey!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Grafía del gasto abierto más reciente del grupo; null = sin proveedor.',
  })
  supplier!: string | null;
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description: 'Vencimiento más antiguo de sus gastos abiertos.',
  })
  oldestDueDate!: string | null;
}

export class PayableCurrencyTotalDto extends PayableAmountsDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;
}

export class ExpensePayablesDto {
  @ApiProperty({
    type: [PayableSupplierRowDto],
    description:
      'Una fila por proveedor × moneda; el vencimiento más antiguo primero.',
  })
  rows!: PayableSupplierRowDto[];
  @ApiProperty({
    type: [PayableCurrencyTotalDto],
    description: 'Totales por moneda; las monedas nunca se suman.',
  })
  totals!: PayableCurrencyTotalDto[];
}

export class PayableExpensesDto {
  @ApiProperty() supplierKey!: string;
  @ApiProperty({ type: String, nullable: true })
  supplier!: string | null;
  @ApiProperty() currency!: string;
  @ApiProperty({
    type: [ExpenseDto],
    description:
      'Gastos abiertos por vencimiento (sin vencimiento al final); hasta 500.',
  })
  items!: ExpenseDto[];
  @ApiProperty({ description: 'Gastos abiertos del grupo, sin el tope.' })
  total!: number;
}
