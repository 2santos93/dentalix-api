import { ApiProperty } from '@nestjs/swagger';
import {
  CollectionChannel,
  CollectionOutcome,
  PaymentPromiseStatus,
} from '@prisma/client';

// Forma de la respuesta de GET /receivables/aging (DX-145). Solo documenta el
// contrato en Swagger (de aquí sale el tipo del cliente web vía
// openapi-typescript). Criterios en ../../application/compute-patient-aging.ts.

export class AgingBucketsDto {
  @ApiProperty({
    description: 'Cuotas de un plan de pagos que todavía no vencen',
  })
  current!: number;

  @ApiProperty({ description: 'Exigible hace 0 a 30 días' })
  days0to30!: number;

  @ApiProperty({ description: 'Exigible hace 31 a 60 días' })
  days31to60!: number;

  @ApiProperty({ description: 'Exigible hace 61 a 90 días' })
  days61to90!: number;

  @ApiProperty({ description: 'Exigible hace más de 90 días' })
  over90!: number;
}

export class AgingNextInstallmentDto {
  @ApiProperty({ format: 'date-time' })
  dueDate!: Date;

  @ApiProperty({ description: 'Lo que falta por cubrir de esa cuota' })
  amount!: number;
}

export class AgingCurrencyDto {
  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({
    description:
      'Saldo neto = debt − credit: el mismo `balance` del estado de cuenta',
  })
  balance!: number;

  @ApiProperty({ description: 'Lo que se debe: Σ de los tramos' })
  debt!: number;

  @ApiProperty({
    description:
      'Saldo a favor (abonos de más o en otra moneda). Nunca se resta de los tramos',
  })
  credit!: number;

  @ApiProperty({ type: AgingBucketsDto })
  buckets!: AgingBucketsDto;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Días de la deuda exigible más antigua; null si nada vence',
  })
  oldestAgeDays!: number | null;

  @ApiProperty({
    description:
      'Parte de la deuda envejece desde la fecha del plan (aceptación, presentación o creación), no desde un vencimiento: «fecha aproximada»',
  })
  ageApproximate!: boolean;

  @ApiProperty({ type: AgingNextInstallmentDto, nullable: true })
  nextInstallment!: AgingNextInstallmentDto | null;
}

export class AgingPatientDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Ana Pérez' })
  fullName!: string;

  @ApiProperty({ type: String, nullable: true, example: '+57 300 123 4567' })
  phone!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '573001234567',
    description:
      'Teléfono en E.164 sin "+", listo para https://wa.me/<número>; null si no hay uno utilizable',
  })
  whatsApp!: string | null;
}

export class AgingLastPaymentDto {
  @ApiProperty({
    example: '2026-09-30',
    description: 'Día civil del abono en la zona de su sede',
  })
  paidOn!: string;

  @ApiProperty()
  amount!: number;

  @ApiProperty({ example: 'COP' })
  currency!: string;
}

export class AgingRowNextInstallmentDto extends AgingNextInstallmentDto {
  @ApiProperty({ example: 'COP' })
  currency!: string;
}

export class AgingLastNoteDto {
  @ApiProperty({ enum: CollectionChannel, enumName: 'CollectionChannel' })
  channel!: CollectionChannel;

  @ApiProperty({ enum: CollectionOutcome, enumName: 'CollectionOutcome' })
  outcome!: CollectionOutcome;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class AgingPromiseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  amount!: number;

  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ example: '2026-11-15', description: 'Día civil de la sede' })
  dueDate!: string;

  @ApiProperty({ enum: PaymentPromiseStatus, enumName: 'PaymentPromiseStatus' })
  status!: PaymentPromiseStatus;
}

export class AgingRowDto {
  @ApiProperty({ type: AgingPatientDto })
  patient!: AgingPatientDto;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Sede de la deuda: la de la última cita atendida; sin citas atendidas, la del último abono; sin abonos, la de la última presentación de un plan; null si no hay ninguna',
  })
  locationId!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Máximo de `oldestAgeDays` de sus monedas',
  })
  oldestAgeDays!: number | null;

  @ApiProperty()
  ageApproximate!: boolean;

  @ApiProperty({
    type: [AgingCurrencyDto],
    description: 'Una entrada por moneda con deuda o saldo a favor',
  })
  currencies!: AgingCurrencyDto[];

  @ApiProperty({ type: AgingLastPaymentDto, nullable: true })
  lastPayment!: AgingLastPaymentDto | null;

  @ApiProperty({
    type: AgingRowNextInstallmentDto,
    nullable: true,
    description: 'La próxima cuota por vencer, de cualquier moneda',
  })
  nextInstallment!: AgingRowNextInstallmentDto | null;

  @ApiProperty({
    type: AgingLastNoteDto,
    nullable: true,
    description: 'DX-150: última gestión de cobro (el texto, en la ficha)',
  })
  lastNote!: AgingLastNoteDto | null;

  @ApiProperty({
    type: AgingPromiseDto,
    nullable: true,
    description:
      'DX-150: último compromiso de pago; el vigente si está OPEN, o cómo terminó (KEPT/BROKEN)',
  })
  promise!: AgingPromiseDto | null;
}

export class AgingTotalDto {
  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ description: 'Deudores con esta moneda' })
  patients!: number;

  @ApiProperty()
  balance!: number;

  @ApiProperty()
  debt!: number;

  @ApiProperty()
  credit!: number;

  @ApiProperty({ type: AgingBucketsDto })
  buckets!: AgingBucketsDto;
}

export class AgingScopeLocationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sede Norte' })
  name!: string;
}

export class AgingScopeDto {
  @ApiProperty({
    type: AgingScopeLocationDto,
    nullable: true,
    description: 'La sede aplicada; null = toda la clínica',
  })
  location!: AgingScopeLocationDto | null;
}

export class ReceivablesAgingPageDto {
  @ApiProperty({
    example: '2026-10-17',
    description: '«Hoy» en la zona de la sede del alcance',
  })
  asOf!: string;

  @ApiProperty({ type: AgingScopeDto })
  scope!: AgingScopeDto;

  @ApiProperty({
    type: [AgingRowDto],
    description:
      'Deudores (algo que deber en alguna moneda), de la deuda vencida más antigua a la más reciente',
  })
  items!: AgingRowDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty({
    type: [AgingTotalDto],
    description: 'Por moneda, de TODAS las filas filtradas (no solo la página)',
  })
  totals!: AgingTotalDto[];
}
