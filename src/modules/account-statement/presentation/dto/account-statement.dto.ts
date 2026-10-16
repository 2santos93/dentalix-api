import { ApiProperty } from '@nestjs/swagger';
import { DocType, PaymentMethod, TreatmentPlanStatus } from '@prisma/client';

// Forma de la respuesta de `GET /patients/:patientId/account-statement`. Solo
// documenta el contrato en Swagger (de aquí sale el tipo del cliente web vía
// `openapi-typescript`), no valida entrada. Criterios de cálculo en
// ../../application/compute-account-statement.ts.

const INSTALLMENT_STATUSES = ['PAID', 'PARTIAL', 'PENDING', 'OVERDUE'] as const;

export class AccountStatementClinicDto {
  @ApiProperty({ example: 'Clínica Sonrisas' })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;
}

export class AccountStatementPatientDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Ana' })
  firstName!: string;

  @ApiProperty({ example: 'Gómez' })
  lastName!: string;

  @ApiProperty({ enum: DocType })
  docType!: DocType;

  @ApiProperty({ type: String, nullable: true })
  docNumber!: string | null;
}

export class AccountStatementRangeDto {
  @ApiProperty({ type: String, nullable: true, example: '2026-01-01' })
  from!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-12-31' })
  to!: string | null;
}

export class AccountStatementNextInstallmentDto {
  @ApiProperty({ format: 'uuid' })
  treatmentPlanId!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '`null` para la cuota inicial.',
  })
  sequence!: number | null;

  @ApiProperty({ format: 'date-time' })
  dueDate!: Date;

  @ApiProperty({ example: 250000, description: 'Lo que falta de esa cuota' })
  amount!: number;
}

export class AccountStatementCurrencySummaryDto {
  @ApiProperty({ example: 'COP', description: 'ISO 4217' })
  currency!: string;

  @ApiProperty({
    example: 3000000,
    description:
      'Σ ítems ACCEPTED|DONE de los planes no cancelados en esta moneda',
  })
  budgeted!: number;

  @ApiProperty({
    example: 1200000,
    description: 'Σ abonos no anulados en esta moneda (sin convertir)',
  })
  paid!: number;

  @ApiProperty({
    example: 1800000,
    description: 'budgeted - paid (negativo = saldo a favor)',
  })
  balance!: number;

  @ApiProperty({ example: 1 })
  overdueCount!: number;

  @ApiProperty({ example: 250000, description: 'Lo que falta de las vencidas' })
  overdueAmount!: number;

  @ApiProperty({ type: AccountStatementNextInstallmentDto, nullable: true })
  nextInstallment!: AccountStatementNextInstallmentDto | null;
}

export class AccountStatementOtherCurrencyDto {
  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({ example: 50 })
  amount!: number;
}

export class AccountStatementPlanDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: TreatmentPlanStatus })
  status!: TreatmentPlanStatus;

  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'El plan no tiene título: se nombra por su fecha.',
  })
  createdAt!: Date;

  @ApiProperty({ example: 3000000, description: 'Ítems ACCEPTED|DONE' })
  budgeted!: number;

  @ApiProperty({
    description:
      '`false` si el plan está CANCELLED o REJECTED: no suma al saldo.',
  })
  countsTowardsBalance!: boolean;

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

  @ApiProperty({ example: 1800000 })
  balance!: number;
}

export class AccountStatementLocationRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sede principal' })
  name!: string;
}

export class AccountStatementVoidedByDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Rita Recepción',
    description:
      'Nombre del usuario; `null` si no es miembro de esta clínica (p. ej. ' +
      'soporte de plataforma).',
  })
  fullName!: string | null;
}

export class AccountStatementMovementDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'Instante del pago (un abono registrado solo con fecha cae al mediodía ' +
      'de su sede). Para mostrar el día, usar `paidOn`.',
  })
  paidAt!: Date;

  @ApiProperty({
    example: '2026-10-16',
    description:
      'Día civil (YYYY-MM-DD) del pago en la zona IANA de la sede del abono ' +
      '(DX-097). Es el día por el que filtran `from`/`to`.',
  })
  paidOn!: string;

  @ApiProperty({ example: 150000 })
  amount!: number;

  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ enum: PaymentMethod, nullable: true })
  method!: PaymentMethod | null;

  @ApiProperty({ type: AccountStatementLocationRefDto })
  location!: AccountStatementLocationRefDto;

  @ApiProperty({ format: 'uuid' })
  treatmentPlanId!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Quién registró el abono; `null` en abonos antiguos sin autor.',
  })
  createdById!: string | null;

  @ApiProperty({
    description:
      'Si quien consulta puede anular este abono: ADMIN cualquiera activo; ' +
      'RECEPTION solo los suyos registrados el mismo día (calendario de la ' +
      'sede del abono). `false` si ya está anulado. Solo orienta a la ' +
      'interfaz: `DELETE /payments/:id` vuelve a aplicar la regla.',
  })
  canVoid!: boolean;

  @ApiProperty({ description: 'Abono anulado: se lista pero no suma.' })
  voided!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  voidedAt!: Date | null;

  @ApiProperty({
    type: () => AccountStatementVoidedByDto,
    nullable: true,
    description:
      'Quién anuló el abono. `null` si está activo o se anuló antes de ' +
      'guardarse el autor.',
  })
  voidedBy!: AccountStatementVoidedByDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Motivo de la anulación. `null` si está activo o es una anulación antigua.',
  })
  voidReason!: string | null;
}

export class AccountStatementInstallmentDto {
  @ApiProperty({ format: 'uuid' })
  paymentPlanId!: string;

  @ApiProperty({ format: 'uuid' })
  treatmentPlanId!: string;

  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ enum: ['DOWN_PAYMENT', 'INSTALLMENT'] })
  kind!: 'DOWN_PAYMENT' | 'INSTALLMENT';

  @ApiProperty({ type: Number, nullable: true })
  sequence!: number | null;

  @ApiProperty({ format: 'date-time' })
  dueDate!: Date;

  @ApiProperty({ example: 250000 })
  amount!: number;

  @ApiProperty({ example: 100000 })
  covered!: number;

  @ApiProperty({ example: 150000 })
  outstanding!: number;

  @ApiProperty({ enum: INSTALLMENT_STATUSES })
  status!: (typeof INSTALLMENT_STATUSES)[number];
}

export class AccountStatementDto {
  @ApiProperty({ format: 'date-time' })
  issuedAt!: Date;

  @ApiProperty({ type: AccountStatementClinicDto })
  clinic!: AccountStatementClinicDto;

  @ApiProperty({ type: AccountStatementPatientDto })
  patient!: AccountStatementPatientDto;

  @ApiProperty({ type: AccountStatementRangeDto })
  range!: AccountStatementRangeDto;

  @ApiProperty({ type: [AccountStatementCurrencySummaryDto] })
  summary!: AccountStatementCurrencySummaryDto[];

  @ApiProperty({ type: [AccountStatementPlanDto] })
  plans!: AccountStatementPlanDto[];

  @ApiProperty({ type: [AccountStatementMovementDto] })
  movements!: AccountStatementMovementDto[];

  @ApiProperty({ type: [AccountStatementInstallmentDto] })
  installments!: AccountStatementInstallmentDto[];
}
