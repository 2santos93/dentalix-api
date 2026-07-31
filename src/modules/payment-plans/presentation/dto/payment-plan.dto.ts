import { ApiProperty } from '@nestjs/swagger';

// Response shape for POST/GET /treatment-plans/:id/payment-plan -- documents
// GetPaymentPlanResult for Swagger (same convention as PlanBalanceDto: exists
// purely for `@ApiProperty` docs, not input validation). See
// ../../application/use-cases/get-payment-plan.use-case.ts for the field
// semantics (derived tramo statuses, next due, overdue aggregation).

export class TramoViewDto {
  @ApiProperty({ example: 100, description: 'Monto del tramo (down payment o cuota)' })
  amount!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  dueDate!: Date;

  @ApiProperty({ example: 100, description: 'Monto ya cubierto por pagos aplicados' })
  covered!: number;

  @ApiProperty({ enum: ['PAID', 'PARTIAL', 'PENDING', 'OVERDUE'] })
  status!: 'PAID' | 'PARTIAL' | 'PENDING' | 'OVERDUE';
}

export class DerivedInstallmentDto {
  @ApiProperty({ example: 1, description: 'Número de cuota (1-indexed)' })
  sequence!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  dueDate!: Date;

  @ApiProperty({ example: 100 })
  amount!: number;

  @ApiProperty({ example: 100, description: 'Monto ya cubierto por pagos aplicados' })
  covered!: number;

  @ApiProperty({ enum: ['PAID', 'PARTIAL', 'PENDING', 'OVERDUE'] })
  status!: 'PAID' | 'PARTIAL' | 'PENDING' | 'OVERDUE';
}

export class NextDueDto {
  @ApiProperty({
    example: 2,
    nullable: true,
    description: 'Número de cuota; null si el próximo vencimiento es el down payment',
  })
  sequence!: number | null;

  @ApiProperty({ type: String, format: 'date-time' })
  dueDate!: Date;

  @ApiProperty({ example: 100 })
  amount!: number;
}

export class PaymentPlanDto {
  @ApiProperty({ example: 'clx1234567890' })
  id!: string;

  @ApiProperty({ example: 'clx0987654321' })
  treatmentPlanId!: string;

  @ApiProperty({ example: 'USD', description: 'ISO 4217 currency code' })
  currency!: string;

  @ApiProperty({ enum: ['ACTIVE', 'COMPLETED', 'CANCELLED'] })
  status!: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

  @ApiProperty({ example: 1200, description: 'Monto total a financiar' })
  totalToFinance!: number;

  @ApiProperty({ example: 200, description: 'Pie/abono inicial' })
  downPayment!: number;

  @ApiProperty({ example: 1000, description: 'totalToFinance - downPayment' })
  financedAmount!: number;

  @ApiProperty({ example: 12, description: 'Número de cuotas' })
  installmentsCount!: number;

  @ApiProperty({ enum: ['WEEKLY', 'BIWEEKLY', 'MONTHLY'] })
  periodicity!: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';

  @ApiProperty({ type: String, format: 'date-time', description: 'Fecha de la 1ª cuota' })
  startDate!: Date;

  @ApiProperty({ example: 300, description: 'Total pagado, convertido a currency del plan' })
  paidTotal!: number;

  @ApiProperty({ example: 900, description: 'totalToFinance - paidTotal, min 0' })
  remaining!: number;

  @ApiProperty({
    type: TramoViewDto,
    nullable: true,
    description: 'Estado derivado del down payment; null si no hay down payment',
  })
  downPaymentStatus!: TramoViewDto | null;

  @ApiProperty({ type: [DerivedInstallmentDto] })
  installments!: DerivedInstallmentDto[];

  @ApiProperty({
    type: NextDueDto,
    nullable: true,
    description: 'Próximo tramo pendiente/vencido; null si el plan está totalmente pagado',
  })
  nextDue!: NextDueDto | null;

  @ApiProperty({ example: 0, description: 'Cantidad de tramos vencidos (OVERDUE)' })
  overdueCount!: number;

  @ApiProperty({ example: 0, description: 'Monto vencido no cubierto (suma de tramos OVERDUE)' })
  overdueAmount!: number;

  @ApiProperty({ example: false, description: 'true si remaining <= 0' })
  isFullyPaid!: boolean;
}
