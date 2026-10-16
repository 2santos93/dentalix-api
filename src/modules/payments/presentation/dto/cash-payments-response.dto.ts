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
    description: 'Día civil del abono (medianoche UTC del día registrado).',
  })
  paidAt!: Date;

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

  @ApiProperty({ type: CashTreatmentPlanRefDto })
  treatmentPlan!: CashTreatmentPlanRefDto;
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
