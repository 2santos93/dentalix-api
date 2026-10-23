import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethod, TreatmentPlanStatus } from '@prisma/client';

// Forma de la respuesta de `GET /payments` (la caja). Existe solo para
// documentar el contrato en Swagger —de ahí sale el tipo del cliente web vía
// `openapi-typescript`—, no para validar entrada. Misma convención que
// CatalogDirectoryResponseDto / ListInventoryItemsResponseDto.

export class CashLocationRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sede principal' })
  name!: string;
}

export class CashPatientRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Ana Gómez', description: 'Nombre y apellido' })
  fullName!: string;
}

export class CashTreatmentPlanRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: TreatmentPlanStatus })
  status!: TreatmentPlanStatus;

  @ApiProperty({
    format: 'date-time',
    description:
      'El plan no tiene título: la web lo nombra por su fecha de creación.',
  })
  createdAt!: Date;
}

export class CashOpeningBalanceRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Saldo migrado' })
  concept!: string;
}

export class CashPaymentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

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
      'Si quien consulta puede anular este abono: ADMIN siempre; RECEPTION ' +
      'solo los que registró ella el mismo día (calendario de la sede del ' +
      'abono). Solo orienta a la interfaz: `DELETE /payments/:id` vuelve a ' +
      'aplicar la regla.',
  })
  canVoid!: boolean;

  @ApiProperty({
    format: 'date-time',
    description:
      'Instante del pago. Un abono registrado solo con fecha (YYYY-MM-DD) se ' +
      'guarda al mediodía de la zona de su sede. Para mostrar el día, usar `paidOn`.',
  })
  paidAt!: Date;

  @ApiProperty({
    example: '2026-10-16',
    description:
      'Día civil (YYYY-MM-DD) de `paidAt` en la zona IANA de la sede del ' +
      'abono (DX-097): el día de caja en que cuenta. Un abono a las 20:00 en ' +
      'Bogotá es de ese día aunque en UTC ya sea el siguiente.',
  })
  paidOn!: string;

  @ApiProperty({
    example: '2026-10-16',
    description:
      'Día civil (YYYY-MM-DD) en que se registró el abono, en la zona de su ' +
      'sede. Puede diferir de `paidOn` (fecha de pago antigua registrada ' +
      'después); la ventana de anulación de recepción mira este día.',
  })
  registeredOn!: string;

  @ApiProperty({
    description: 'Si `registeredOn` es hoy en la zona de la sede del abono.',
  })
  registeredToday!: boolean;

  @ApiProperty({ example: 150000 })
  amount!: number;

  @ApiProperty({ example: 'COP', description: 'ISO 4217 currency code' })
  currency!: string;

  @ApiProperty({ enum: PaymentMethod, nullable: true })
  method!: PaymentMethod | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ type: CashLocationRefDto })
  location!: CashLocationRefDto;

  @ApiProperty({ type: CashPatientRefDto })
  patient!: CashPatientRefDto;

  @ApiProperty({
    type: CashTreatmentPlanRefDto,
    nullable: true,
    description: 'null si el abono es contra un saldo migrado (DX-262)',
  })
  treatmentPlan!: CashTreatmentPlanRefDto | null;

  @ApiProperty({
    type: CashOpeningBalanceRefDto,
    nullable: true,
    description: 'Saldo migrado del abono (DX-262); null si es a un plan',
  })
  openingBalance!: CashOpeningBalanceRefDto | null;
}

export class CashCurrencyTotalDto {
  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ example: 350000, description: 'Suma sin convertir' })
  total!: number;

  @ApiProperty({ example: 3 })
  count!: number;
}

export class CashMethodTotalDto {
  @ApiProperty({
    enum: PaymentMethod,
    nullable: true,
    description: '`null` = abonos registrados sin método',
  })
  method!: PaymentMethod | null;

  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ example: 200000 })
  total!: number;

  @ApiProperty({ example: 2 })
  count!: number;
}

export class CashPaymentsSummaryDto {
  @ApiProperty({ description: 'Número de abonos del período' })
  count!: number;

  @ApiProperty({
    type: [CashCurrencyTotalDto],
    description:
      'Total por moneda, sin convertir (no hay moneda base de la clínica).',
  })
  byCurrency!: CashCurrencyTotalDto[];

  @ApiProperty({
    type: [CashMethodTotalDto],
    description: 'Total por método y moneda.',
  })
  byMethod!: CashMethodTotalDto[];
}

export class CashScopeDto {
  @ApiProperty({
    type: CashLocationRefDto,
    nullable: true,
    description:
      'Sede activa del request (X-Location-Id), o null = todas las sedes.',
  })
  location!: CashLocationRefDto | null;
}

export class CashPaymentsResponseDto {
  @ApiProperty({ type: [CashPaymentDto] })
  items!: CashPaymentDto[];

  @ApiProperty({
    description: 'Abonos que casan con los filtros, no solo los de la página',
  })
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;

  @ApiProperty({ example: '2026-10-01' })
  from!: string;

  @ApiProperty({ example: '2026-10-31' })
  to!: string;

  @ApiProperty({ type: CashScopeDto })
  scope!: CashScopeDto;

  @ApiProperty({
    type: CashPaymentsSummaryDto,
    description: 'Resumen del período entero con los mismos filtros.',
  })
  summary!: CashPaymentsSummaryDto;
}
