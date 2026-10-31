import { ApiProperty } from '@nestjs/swagger';
import { TreatmentPlanItemStatus } from '@prisma/client';

// Response shape for GET /treatment-plans/:id/balance -- documents
// GetPlanBalanceResult for Swagger (same convention as PaymentDto: exists
// purely for `@ApiProperty` docs, not input validation). See
// ../../application/use-cases/get-plan-balance.use-case.ts for the field
// semantics (billable/paid/balance rounding, paymentsCount).
/** DX-375: un abono «sin tasa» del saldo. */
export class PaymentWithoutRateDto {
  @ApiProperty({ format: 'uuid' })
  paymentId!: string;

  @ApiProperty({ example: 150000, description: 'En la moneda del abono' })
  amount!: number;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({
    example: '2026-10-30',
    description: 'Día civil del abono en su sede: el de la tasa que falta',
  })
  paidOn!: string;
}

export class PlanBalanceDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  planCurrency!: string;

  @ApiProperty({
    example: 300,
    description: 'Sum of ACCEPTED|DONE item prices minus their discounts',
  })
  billable!: number;

  @ApiProperty({
    example: 100,
    description:
      'Σ de los abonos vivos en planCurrency, cada uno con la tasa que ' +
      'congeló al registrarse (DX-375; con base de imputación, por su base). ' +
      'Un abono anterior aún sin congelar, con la tasa de su día. Los «sin ' +
      'tasa» (paymentsWithoutRate) no suman.',
  })
  paid!: number;

  @ApiProperty({
    example: 0,
    description:
      'DX-253: Σ traspasos y devoluciones de saldo a favor del plan en planCurrency, con signo (los abonos no cambian).',
  })
  creditMovements!: number;

  @ApiProperty({
    example: 200,
    description: 'billable - paid - creditMovements',
  })
  balance!: number;

  @ApiProperty({ example: 1 })
  paymentsCount!: number;

  @ApiProperty({
    type: [PaymentWithoutRateDto],
    description:
      'DX-375: abonos vivos «sin tasa» (en otra moneda y sin tasa de su día): ' +
      'no cuentan en paid, así que el saldo está incompleto hasta que se ' +
      'registre la tasa (Ajustes › Tasa de cambio) y el barrido la congele. ' +
      'Vacío si no hay ninguno.',
  })
  paymentsWithoutRate!: PaymentWithoutRateDto[];

  @ApiProperty({
    example: false,
    description:
      'DX-054: el proveedor de tasas no respondió a tiempo (el saldo espera ' +
      'como mucho 4 s a las conversiones en vivo). Los abonos que esperaban ' +
      'su tasa salen en paymentsWithoutRate y no suman en paid: el saldo está ' +
      'incompleto y volver a pedirlo lo completa cuando el proveedor responda. ' +
      'Nunca es un 500.',
  })
  rateProviderTimedOut!: boolean;
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

  @ApiProperty({
    enum: TreatmentPlanItemStatus,
    enumName: 'TreatmentPlanItemStatus',
  })
  status!: TreatmentPlanItemStatus;

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
