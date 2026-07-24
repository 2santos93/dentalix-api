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
    description: 'Sum of ACCEPTED|DONE item prices',
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
