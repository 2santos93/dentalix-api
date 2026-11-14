import { ClinicFiscalDto } from '../../../../shared/clinic/clinic-fiscal.dto';
import { ApiProperty } from '@nestjs/swagger';
import { DocumentRegionalDto } from '../../../../shared/locations/document-regional.dto';
import {
  type DocumentType,
  PaymentMethod,
  ResponsibleRelationship,
  TreatmentPlanStatus,
} from '@prisma/client';
import { DOCUMENT_TYPES } from '../../../patients/domain/document-type';
import { PaymentWithoutRateDto } from '../../../payments/presentation/dto/plan-balance.dto';
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

  @ApiProperty({
    type: ClinicFiscalDto,
    description: 'DX-019: datos fiscales y de contacto.',
  })
  fiscal!: ClinicFiscalDto;
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
      'Σ ítems ACCEPTED|DONE de los planes no cancelados en esta moneda (Σ billable de esos planes)',
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
    description:
      'Σ abonos no anulados en esta moneda, sin convertir: lo entregado en ella, la cifra de la cartera. Lo que cuadra con plans[] es convertedPaid.',
  })
  paid!: number;

  @ApiProperty({
    example: 0,
    description:
      'DX-253: Σ traspasos y devoluciones de saldo a favor en esta moneda, con signo. balance = budgeted + openingBalance − paid − creditMovements',
  })
  creditMovements!: number;

  @ApiProperty({
    example: 1950000,
    description:
      'budgeted + openingBalance - paid - creditMovements (negativo = saldo a favor), sin convertir: la cifra de la cartera. Lo que cuadra con plans[] es convertedBalance.',
  })
  balance!: number;

  @ApiProperty({
    example: 1200000,
    description:
      'DX-472: Σ plans[].paid en esta moneda (abonos convertidos a ella, como en /balance) más los abonos a saldos migrados de esta moneda. Difiere de paid a propósito: si todos los abonos son en la moneda del plan, coincide.',
  })
  convertedPaid!: number;

  @ApiProperty({
    example: 1950000,
    description:
      'DX-472: budgeted + openingBalance - convertedPaid - creditMovements: el saldo que cuadra con plans[].',
  })
  convertedBalance!: number;

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

  @ApiProperty({
    example: 3000000,
    description:
      'Ítems ACCEPTED|DONE, aunque el plan esté cancelado o rechazado. Difiere de billable a propósito: es lo que se presupuestó, no lo que se cobra.',
  })
  budgeted!: number;

  @ApiProperty({
    example: 3000000,
    description:
      'DX-472: el billable de GET /treatment-plans/:id/balance: ítems ACCEPTED|DONE; 0 si el plan está cancelado o rechazado.',
  })
  billable!: number;

  @ApiProperty({
    description:
      '`false` si el plan está CANCELLED o REJECTED: no suma al saldo.',
  })
  countsTowardsBalance!: boolean;

  @ApiProperty({
    example: 1200000,
    description:
      'DX-472: el paid de /balance: abonos vivos convertidos a la moneda del plan con la tasa de cada uno. Los «sin tasa» (paymentsWithoutRate) no suman.',
  })
  paid!: number;

  @ApiProperty({
    example: -200000,
    description:
      'DX-253: Σ asientos del saldo a favor del plan en su moneda, con signo (traspasos recibidos − dados − devoluciones). Los abonos no cambian.',
  })
  creditMovements!: number;

  @ApiProperty({
    type: [AccountStatementOtherCurrencyDto],
    description:
      'Abonos vivos del plan hechos en otra moneda, en esa moneda y sin convertir: lo que el paciente entregó. Solo informa: si tenían tasa, ya cuentan en paid.',
  })
  paidOtherCurrencies!: AccountStatementOtherCurrencyDto[];

  @ApiProperty({
    example: 1800000,
    description:
      'DX-472: el balance de /balance: billable - paid - creditMovements.',
  })
  balance!: number;

  @ApiProperty({
    type: [PaymentWithoutRateDto],
    description:
      'DX-472: abonos del plan que no suman en paid por no tener tasa, como en /balance.',
  })
  paymentsWithoutRate!: PaymentWithoutRateDto[];

  @ApiProperty({
    example: false,
    description:
      'DX-472: el proveedor de tasas no respondió a tiempo: paid está incompleto y las cuotas de este plan no salen OVERDUE mientras tanto.',
  })
  rateProviderTimedOut!: boolean;
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
    nullable: true,
    example: '00-000123',
    description:
      'DX-515: nº de la factura fiscal emitida fuera de Dentalix para el ' +
      'abono (texto libre), o `null` si no se anotó.',
  })
  externalInvoiceNumber!: string | null;

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

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'PRI-000123',
    description:
      'DX-414: número del recibo de caja del abono (DX-136); todas las líneas ' +
      'de un cobro dividido llevan el de su recibo único. `null` en un abono ' +
      'anterior a la numeración.',
  })
  receiptNumber!: string | null;

  @ApiProperty({
    description:
      'DX-389: el abono tiene comprobante del cobro (la captura del pago móvil o de la transferencia). Se ve con `GET /payments/:id/proof/url` (solo ADMIN y recepción).',
  })
  hasProof!: boolean;

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

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-432: por qué este abono no se anula aunque su rol pueda (es ' +
      'referencia de una devolución, que no se deshace), con el texto del ' +
      '409 de `DELETE /payments/:id`. `null` si nada lo impide. La ' +
      'interfaz lo pinta como «Anular» deshabilitado con esta explicación.',
  })
  voidBlockedReason!: string | null;

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

  @ApiProperty({
    type: DocumentRegionalDto,
    nullable: true,
    description:
      'DX-354: zona, locale y reloj de la sede en contexto (o la principal) para formatear el impreso. null si a la sede le falta algo: el documento se lee igual y la web pinta «—».',
  })
  regional!: DocumentRegionalDto | null;

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

  @ApiProperty({
    example: false,
    description:
      'DX-472: en algún plan, el proveedor de tasas no respondió a tiempo (el saldo espera como mucho 4 s): esas cifras están incompletas y volver a pedirlas las completa. Nunca es un 500.',
  })
  rateProviderTimedOut!: boolean;
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

  @ApiProperty({ description: 'Igual que `summary[].paid`: sin convertir' })
  paid!: number;

  @ApiProperty({ description: 'Igual que `summary[].balance`: sin convertir' })
  balance!: number;

  @ApiProperty({ description: 'DX-472: igual que `summary[].convertedPaid`' })
  convertedPaid!: number;

  @ApiProperty({
    description: 'DX-472: igual que `summary[].convertedBalance`',
  })
  convertedBalance!: number;

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

  @ApiProperty({
    type: DocumentRegionalDto,
    nullable: true,
    description:
      'DX-354: zona, locale y reloj de la sede en contexto (o la principal) para formatear el impreso. null si a la sede le falta algo: el documento se lee igual y la web pinta «—».',
  })
  regional!: DocumentRegionalDto | null;

  @ApiProperty({ type: FamilyMemberPatientDto })
  payer!: FamilyMemberPatientDto;

  @ApiProperty({ type: [FamilyStatementMemberDto] })
  members!: FamilyStatementMemberDto[];

  @ApiProperty({
    type: [FamilyCurrencyAmountsDto],
    description: 'Suma de los subtotales por moneda, al céntimo.',
  })
  totals!: FamilyCurrencyAmountsDto[];

  @ApiProperty({
    example: 0,
    description:
      'DX-472: abonos de la familia que no suman por no tener tasa (paymentsWithoutRate de sus planes): las cifras están incompletas.',
  })
  paymentsWithoutRateCount!: number;

  @ApiProperty({
    example: false,
    description:
      'DX-472: en algún plan de la familia, el proveedor de tasas no respondió a tiempo: las cifras están incompletas.',
  })
  rateProviderTimedOut!: boolean;
}
