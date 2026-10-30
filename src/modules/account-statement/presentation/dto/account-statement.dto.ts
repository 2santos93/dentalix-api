import { ApiProperty } from '@nestjs/swagger';
import {
  type DocumentType,
  PaymentMethod,
  ResponsibleRelationship,
  TreatmentPlanStatus,
} from '@prisma/client';
import { DOCUMENT_TYPES } from '../../../patients/domain/document-type';
import {
  DOC_TYPE_LABEL_PROPERTY,
  DOC_TYPE_NAME_DESCRIPTION,
} from '../../../patients/presentation/dto/doc-type-input';

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

  @ApiProperty({ enum: DOCUMENT_TYPES, enumName: 'DocType' })
  docType!: DocumentType;

  @ApiProperty(DOC_TYPE_LABEL_PROPERTY)
  docTypeLabel!: string | null;

  @ApiProperty({ description: DOC_TYPE_NAME_DESCRIPTION })
  docTypeName!: string;

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
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({
    example: 3000000,
    description:
      'Σ ítems ACCEPTED|DONE de los planes no cancelados en esta moneda',
  })
  budgeted!: number;

  @ApiProperty({
    example: 150000,
    description:
      'DX-262: Σ saldos migrados vivos en esta moneda (deuda traída del programa anterior)',
  })
  openingBalance!: number;

  @ApiProperty({
    example: 100000,
    description:
      'DX-262 (QA D5): lo que queda pendiente de esos saldos migrados tras sus abonos; es lo que «incluye» el saldo',
  })
  openingPending!: number;

  @ApiProperty({
    example: 1200000,
    description: 'Σ abonos no anulados en esta moneda (sin convertir)',
  })
  paid!: number;

  @ApiProperty({
    example: 1950000,
    description: 'budgeted + openingBalance - paid (negativo = saldo a favor)',
  })
  balance!: number;

  @ApiProperty({ example: 1 })
  overdueCount!: number;

  @ApiProperty({ example: 250000, description: 'Lo que falta de las vencidas' })
  overdueAmount!: number;

  @ApiProperty({ type: AccountStatementNextInstallmentDto, nullable: true })
  nextInstallment!: AccountStatementNextInstallmentDto | null;
}

/** Línea «Saldo migrado» (DX-262). */
export class AccountStatementOpeningBalanceDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({ example: 150000 })
  amount!: number;

  @ApiProperty({
    example: '2026-03-15',
    description: 'Fecha de corte (día civil AAAA-MM-DD) desde la que cuenta',
  })
  asOfDate!: string;

  @ApiProperty({
    description:
      'La fecha es la de la importación: el archivo no traía fecha de antigüedad («aprox.»)',
  })
  asOfDateApproximate!: boolean;

  @ApiProperty({ example: 'Saldo migrado' })
  concept!: string;

  @ApiProperty({ format: 'uuid', description: 'Lote de importación' })
  importBatchId!: string;

  @ApiProperty({
    example: 50000,
    description: 'Abonos vivos contra este saldo, en su moneda',
  })
  paid!: number;

  @ApiProperty({ example: 100000, description: 'amount − paid: lo pendiente' })
  pending!: number;
}

export class AccountStatementOtherCurrencyDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({ example: 50 })
  amount!: number;
}

export class AccountStatementPlanDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: TreatmentPlanStatus })
  status!: TreatmentPlanStatus;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
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

export class AccountStatementPaymentMethodRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Pago móvil' })
  name!: string;
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

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({
    enum: PaymentMethod,
    nullable: true,
    description:
      'Método antiguo, derivado del tipo base del medio (un medio digital ' +
      'es TRANSFER). Para mostrar, usar `paymentMethod.name`.',
  })
  method!: PaymentMethod | null;

  @ApiProperty({
    type: AccountStatementPaymentMethodRefDto,
    nullable: true,
    description:
      'DX-395: medio de pago de la clínica con que se cobró (también los ' +
      'propios, como «Pago móvil»). Un abono de una réplica anterior sin ' +
      'medio lleva el medio inicial de su método; `null` si no tiene método.',
  })
  paymentMethod!: AccountStatementPaymentMethodRefDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'ABC 123',
    description:
      'DX-395: referencia del pago tal como se tecleó, o `null`. Solo la ven ' +
      'los roles de cobro (este endpoint) y el paciente en su estado de cuenta.',
  })
  reference!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'DX-390: el cobro dividido del abono (el id de su línea 1); `null` en ' +
      'un abono de una sola forma de pago. Anular una línea anula el cobro entero.',
  })
  splitId!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 2,
    description:
      'DX-390: cuántas formas de pago tiene su cobro dividido; `null` en un abono suelto.',
  })
  splitLines!: number | null;

  @ApiProperty({ type: AccountStatementLocationRefDto })
  location!: AccountStatementLocationRefDto;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null si el abono es contra un saldo migrado (DX-262)',
  })
  treatmentPlanId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Saldo migrado del abono (DX-262), o null',
  })
  openingBalanceId!: string | null;

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

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
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

/** DX-203: a nombre de quién sale el estado de cuenta. */
export class AccountStatementAddresseeDto {
  @ApiProperty({
    enum: ['PATIENT', 'RESPONSIBLE'],
    enumName: 'StatementAddresseeKind',
    description:
      'RESPONSIBLE: un menor (menor que la mayoría de edad de la clínica) o un paciente sin email; sale a nombre de su responsable que recibe avisos (primero el pagador principal).',
  })
  kind!: 'PATIENT' | 'RESPONSIBLE';

  @ApiProperty({ description: 'Nombre completo' })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;
}

export class AccountStatementDto {
  @ApiProperty({ format: 'date-time' })
  issuedAt!: Date;

  @ApiProperty({ type: AccountStatementClinicDto })
  clinic!: AccountStatementClinicDto;

  @ApiProperty({ type: AccountStatementPatientDto })
  patient!: AccountStatementPatientDto;

  @ApiProperty({ type: AccountStatementAddresseeDto })
  addressee!: AccountStatementAddresseeDto;

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

  @ApiProperty({
    type: [AccountStatementOpeningBalanceDto],
    description:
      'DX-262: saldos migrados vivos, de la fecha de corte más antigua a la más reciente',
  })
  openingBalances!: AccountStatementOpeningBalanceDto[];
}

// ---------------------------------------------------------------------------
// `GET /patients/:patientId/family-account-statement` (DX-203).
// ---------------------------------------------------------------------------

export class FamilyCurrencyAmountsDto {
  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({ description: 'Igual que `summary[].budgeted` individual' })
  budgeted!: number;

  @ApiProperty({ description: 'DX-262: saldo migrado, ya incluido en balance' })
  openingBalance!: number;

  @ApiProperty({
    description: 'DX-262 (QA D5): lo que queda pendiente del saldo migrado',
  })
  openingPending!: number;

  @ApiProperty()
  paid!: number;

  @ApiProperty()
  balance!: number;

  @ApiProperty()
  overdueAmount!: number;
}

export class FamilyMemberPatientDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;
}

export class FamilyStatementMemberDto {
  @ApiProperty({ type: FamilyMemberPatientDto })
  patient!: FamilyMemberPatientDto;

  @ApiProperty({
    enum: ResponsibleRelationship,
    enumName: 'ResponsibleRelationship',
    nullable: true,
    description:
      'Parentesco del pagador con el paciente; null = el propio pagador.',
  })
  relationship!: ResponsibleRelationship | null;

  @ApiProperty({ description: 'Es el propio pagador' })
  self!: boolean;

  @ApiProperty({
    type: [FamilyCurrencyAmountsDto],
    description: 'Subtotal del paciente: su estado de cuenta individual.',
  })
  summary!: FamilyCurrencyAmountsDto[];
}

export class FamilyAccountStatementDto {
  @ApiProperty({ format: 'date-time' })
  issuedAt!: Date;

  @ApiProperty({ type: AccountStatementClinicDto })
  clinic!: AccountStatementClinicDto;

  @ApiProperty({ type: FamilyMemberPatientDto })
  payer!: FamilyMemberPatientDto;

  @ApiProperty({ type: [FamilyStatementMemberDto] })
  members!: FamilyStatementMemberDto[];

  @ApiProperty({
    type: [FamilyCurrencyAmountsDto],
    description: 'Suma de los subtotales por moneda, al céntimo.',
  })
  totals!: FamilyCurrencyAmountsDto[];
}
