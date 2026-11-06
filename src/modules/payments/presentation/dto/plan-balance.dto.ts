import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
      'como mucho 4 s a las conversiones en vivo), se sabe que no contesta o ' +
      'su cupo está agotado: ' +
      'no es que falte la tasa. Los abonos que esperaban ' +
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

  @ApiProperty({
    example: 60,
    description:
      'Σ de lo imputado al ítem por los abonos más lo que le cubre el saldo recibido por traspaso (paidByTransfersIn, DX-399-quater)',
  })
  paid!: number;

  @ApiProperty({ example: 40, description: 'billable - paid' })
  balance!: number;

  @ApiPropertyOptional({
    example: 30,
    description:
      'DX-399-quater: de `paid`, lo que cubre el saldo que el plan recibió por traspaso de otro plan del paciente y que ninguna devolución ni traspaso de salida gastó. Cubre lo que los abonos no cubren, después de ellos. Ausente si es 0',
  })
  paidByTransfersIn?: number;
}

export class PlanBalanceWithItemsDto extends PlanBalanceDto {
  @ApiProperty({ example: 150, description: 'Σ de lo imputado a los ítems' })
  allocated!: number;

  @ApiProperty({
    example: 30,
    description:
      'Cobrado (con base) sin imputar a ningún ítem, NETO de lo devuelto o traspasado del saldo a favor que se atribuye a los abonos (DX-399-ter, también en un plan cancelado o rechazado): la suma de `onAccount` de `GET /payments/:id/allocations` de los abonos del plan y, si el plan se cobra, lo que da el informe «Cobrado sin imputar»',
  })
  unallocated!: number;

  @ApiPropertyOptional({
    example: 30,
    description:
      'DX-399-quater: lo que el plan recibió por traspaso y que no gastó ninguna salida ni cubre ningún ítem: sigue a cuenta del plan, aparte de `unallocated` (que es de los abonos). Ausente si es 0',
  })
  transfersInOnAccount?: number;

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
