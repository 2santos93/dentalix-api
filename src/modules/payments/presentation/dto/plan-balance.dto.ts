import { ApiProperty } from '@nestjs/swagger';

// Response shape for GET /treatment-plans/:id/balance -- documents
// GetPlanBalanceResult for Swagger (same convention as PaymentDto: exists
// purely for `@ApiProperty` docs, not input validation). See
// ../../application/use-cases/get-plan-balance.use-case.ts for the field
// semantics (billable/paid/balance rounding, paymentsCount).
export class PlanBalanceDto {
  @ApiProperty({ example: 'USD', description: 'ISO 4217 currency code' })
  planCurrency!: string;

  @ApiProperty({
    example: 300,
    description: 'Sum of ACCEPTED|DONE item prices minus their discounts',
  })
  billable!: number;

  @ApiProperty({
    example: 100,
    description:
      'Sum of active payments, each converted to planCurrency at its own paidAt date',
  })
  paid!: number;

  @ApiProperty({ example: 200, description: 'billable - paid' })
  balance!: number;

  @ApiProperty({ example: 1 })
  paymentsCount!: number;
}

// DX-051: cobrado y pendiente por ítem, en el orden del plan. Lleva diente y
// procedimiento porque recepción no tiene acceso al plan ni al catálogo.
export class PlanItemBalanceDto {
  @ApiProperty({ format: 'uuid' })
  itemId!: string;

  @ApiProperty({ example: '11' })
  toothNumber!: string;

  @ApiProperty({
    example: 'Resina',
    description:
      'Rótulo en español del catálogo (`labelEs`); la selección de idioma es una mejora futura',
  })
  procedureName!: string;

  @ApiProperty({ enum: ['PROPOSED', 'ACCEPTED', 'DONE'] })
  status!: string;

  @ApiProperty({
    example: 100,
    description:
      'price - discount si el ítem es ACCEPTED|DONE y el plan es cobrable; si no, 0',
  })
  billable!: number;

  @ApiProperty({ example: 60, description: 'Σ de lo imputado al ítem' })
  paid!: number;

  @ApiProperty({ example: 40, description: 'billable - paid' })
  balance!: number;
}

export class PlanBalanceWithItemsDto extends PlanBalanceDto {
  @ApiProperty({ example: 150, description: 'Σ de lo imputado a los ítems' })
  allocated!: number;

  @ApiProperty({
    example: 30,
    description: 'Cobrado (con base) que aún no está imputado a ningún ítem',
  })
  unallocated!: number;

  @ApiProperty({
    example: 0,
    description: 'Abonos vivos sin base (sin tasa): no se imputan',
  })
  unconvertedPaymentsCount!: number;

  @ApiProperty({
    type: [String],
    description: 'Abonos cuya imputación fijó un ADMIN a mano',
  })
  manualPaymentIds!: string[];

  @ApiProperty({ type: [PlanItemBalanceDto] })
  items!: PlanItemBalanceDto[];
}
