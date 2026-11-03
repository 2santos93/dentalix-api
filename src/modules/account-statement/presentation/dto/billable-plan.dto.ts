import { ApiProperty } from '@nestjs/swagger';
import { TreatmentPlanStatus } from '@prisma/client';
import { AccountStatementOtherCurrencyDto } from './account-statement.dto';
import { PaymentWithoutRateDto } from '../../../payments/presentation/dto/plan-balance.dto';

// Forma de cada elemento de `GET /patients/:patientId/billable-plans` (DX-067).
// Solo documenta el contrato en Swagger (de aquí sale el tipo del cliente web);
// criterios en ../../application/compute-billable-plans.ts. Sin datos
// clínicos: ni ítems, ni dientes, ni procedimientos, ni notas.
export class BillablePlanDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: TreatmentPlanStatus,
    description:
      'Nunca CANCELLED ni REJECTED: un plan cancelado o rechazado no se cobra.',
  })
  status!: TreatmentPlanStatus;

  @ApiProperty({
    description: 'Moneda del plan (la del saldo y la del plan de cuotas)',
  })
  currency!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'El plan no tiene título: se nombra por su fecha.',
  })
  createdAt!: Date;

  @ApiProperty({
    example: 3000000,
    description: 'Facturable: Σ ítems ACCEPTED|DONE, en la moneda del plan',
  })
  total!: number;

  @ApiProperty({
    example: 1200000,
    description:
      'Abonado en la moneda del plan, con los traspasos del saldo a favor. ' +
      'DX-472-bis: lo abonado en otra moneda cuenta convertido con su tasa, ' +
      'el mismo `paid` + `creditMovements` de GET /treatment-plans/:id/balance',
  })
  paid!: number;

  @ApiProperty({
    type: [AccountStatementOtherCurrencyDto],
    description:
      'Abonos vivos del plan hechos en otra moneda, tal como se entregaron (ya convertidos en `paid`)',
  })
  paidOtherCurrencies!: AccountStatementOtherCurrencyDto[];

  @ApiProperty({
    example: 1800000,
    description:
      '`total - paid`; negativo = a favor del paciente. El `balance` de GET /treatment-plans/:id/balance (DX-472-bis)',
  })
  balance!: number;

  @ApiProperty({
    description:
      'Si ya tiene un plan de cuotas activo (solo se admite uno por plan: ' +
      'crear otro responde 409).',
  })
  hasActivePaymentPlan!: boolean;

  @ApiProperty({
    type: [PaymentWithoutRateDto],
    description:
      'DX-472-bis: abonos en otra moneda que no suman en `paid` por falta de tasa (o porque el proveedor no respondió): los de GET /treatment-plans/:id/balance',
  })
  paymentsWithoutRate!: PaymentWithoutRateDto[];

  @ApiProperty({
    description:
      'DX-472-bis: el proveedor de tasas no respondió a tiempo; volver a pedir la lista lo completa',
  })
  rateProviderTimedOut!: boolean;
}
