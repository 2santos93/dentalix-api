import { ApiProperty } from '@nestjs/swagger';
import { TreatmentPlanStatus } from '@prisma/client';
import { AccountStatementOtherCurrencyDto } from './account-statement.dto';

// Forma de cada elemento de `GET /patients/:patientId/billable-plans` (DX-067).
// Solo documenta el contrato en Swagger (de aquí sale el tipo del cliente web);
// criterios en ../../application/compute-billable-plans.ts. Sin datos
// clínicos: ni ítems, ni dientes, ni procedimientos, ni notas.
export class BillablePlanDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: TreatmentPlanStatus,
    description: 'Nunca CANCELLED: un plan cancelado no se cobra.',
  })
  status!: TreatmentPlanStatus;

  @ApiProperty({
    example: 'COP',
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
    description: 'Abonos vivos en la moneda del plan',
  })
  paid!: number;

  @ApiProperty({
    type: [AccountStatementOtherCurrencyDto],
    description: 'Abonos vivos del plan hechos en otra moneda (sin convertir)',
  })
  paidOtherCurrencies!: AccountStatementOtherCurrencyDto[];

  @ApiProperty({
    example: 1800000,
    description: '`total - paid`; negativo = a favor del paciente',
  })
  balance!: number;

  @ApiProperty({
    description:
      'Si ya tiene un plan de cuotas activo (solo se admite uno por plan: ' +
      'crear otro responde 409).',
  })
  hasActivePaymentPlan!: boolean;
}
