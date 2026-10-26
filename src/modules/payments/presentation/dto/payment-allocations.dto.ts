import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TreatmentPlanStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  Allow,
  IsIn,
  IsUUID,
  Matches,
  ValidateBy,
  ValidateNested,
  type ValidationArguments,
} from 'class-validator';
import {
  MONEY_MAX,
  decimalPlaces,
} from '../../../../shared/validation/bounded-decimal';
import { MAX_ALLOCATION_LINES } from '../../domain/allocation-rules';
import {
  ALLOCATION_INVALID_AMOUNT,
  ALLOCATION_ITEM_NOT_IN_PLAN,
  ALLOCATION_MODE_INVALID,
  ALLOCATION_MODE_MISMATCH,
  ALLOCATION_TOO_MANY_LINES,
  ALLOCATION_VERSION_INVALID,
} from '../../domain/allocation-messages';

// DX-051 (spec §5.2): la imputación de un abono a los ítems de su plan y su
// reasignación por un ADMIN. Importes en la moneda del plan salvo
// `paymentAmount` (moneda del abono).

export const ALLOCATION_MODES = ['MANUAL', 'AUTO'] as const;
export type AllocationMode = (typeof ALLOCATION_MODES)[number];

export class PaymentAllocationLineDto {
  @ApiProperty({ format: 'uuid' })
  treatmentPlanItemId!: string;

  @ApiProperty({ example: 50, description: 'En la moneda del plan' })
  amount!: number;

  @ApiProperty({ enum: ['AUTO', 'MANUAL'] })
  source!: 'AUTO' | 'MANUAL';
}

export class AllocationItemOptionDto {
  @ApiProperty({ format: 'uuid' })
  itemId!: string;

  @ApiProperty({ example: '11' })
  toothNumber!: string;

  @ApiProperty({ example: 'Resina' })
  procedureName!: string;

  @ApiProperty({ enum: ['ACCEPTED', 'DONE'] })
  status!: 'ACCEPTED' | 'DONE';

  @ApiProperty({ example: 100, description: 'price − discount' })
  billable!: number;

  @ApiProperty({ example: 30, description: 'Lo que le imputan otros abonos' })
  paidByOthers!: number;

  @ApiProperty({
    example: 70,
    description: 'Lo que este abono puede imputarle: billable − paidByOthers',
  })
  free!: number;
}

export class PaymentAllocationsDto {
  @ApiProperty({ format: 'uuid' })
  paymentId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'NOR-000123',
    description: 'Null en los abonos anteriores a la numeración (DX-136)',
  })
  receiptNumber!: string | null;

  @ApiProperty({ format: 'uuid' })
  treatmentPlanId!: string;

  @ApiProperty({ example: 100, description: 'En la moneda del abono' })
  paymentAmount!: number;

  @ApiProperty({ example: 'USD' })
  paymentCurrency!: string;

  @ApiProperty({
    example: '2026-10-20',
    description: 'Día civil del abono en su sede: la fecha de la tasa',
  })
  paidOn!: string;

  @ApiProperty({ example: 'EUR' })
  planCurrency!: string;

  @ApiProperty({
    enum: TreatmentPlanStatus,
    enumName: 'TreatmentPlanStatus',
    description:
      'Estado del plan: rechazado o cancelado no admite reasignar (409 en el PUT) y sus `items` vienen vacíos',
  })
  planStatus!: TreatmentPlanStatus;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 90,
    description:
      'El abono convertido a la moneda del plan con la tasa de su paidOn; null si aún no hay tasa',
  })
  planAmount!: number | null;

  @ApiProperty({ description: 'Imputación fijada a mano por un ADMIN' })
  manual!: boolean;

  @ApiProperty({ example: 70 })
  allocated!: number;

  @ApiProperty({ type: Number, nullable: true, example: 20 })
  unallocated!: number | null;

  @ApiProperty({
    description: 'Versión de la imputación: se reenvía como expectedVersion',
  })
  version!: string;

  @ApiProperty({ type: [PaymentAllocationLineDto] })
  allocations!: PaymentAllocationLineDto[];

  @ApiProperty({
    type: [AllocationItemOptionDto],
    description: 'Ítems imputables del plan, en el orden del plan',
  })
  items!: AllocationItemOptionDto[];
}

export class PreviousAllocationLineDto {
  @ApiProperty({ format: 'uuid' })
  treatmentPlanItemId!: string;

  @ApiProperty({ example: 50 })
  amount!: number;
}

export class ReplacedPaymentAllocationsDto extends PaymentAllocationsDto {
  @ApiProperty({
    type: [PreviousAllocationLineDto],
    description: 'Las líneas de antes de guardar',
  })
  previous!: PreviousAllocationLineDto[];
}

export class ReplaceAllocationLineDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: ALLOCATION_ITEM_NOT_IN_PLAN })
  treatmentPlanItemId!: string;

  // Lo valida `allocationLinesError` desde `allocations`, con el mensaje de
  // §5.3 sin el prefijo `allocations.N.` de la validación anidada.
  @Allow()
  @ApiProperty({
    example: 50,
    description: 'En la moneda del plan; > 0 y 2 decimales como máximo',
    maximum: MONEY_MAX,
  })
  amount!: number;
}

const isMoneyAmount = (value: unknown): boolean =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value > 0 &&
  value <= MONEY_MAX &&
  decimalPlaces(value) <= 2;

/**
 * El primer error de `allocations` según el modo, o `null`: un solo mensaje
 * de §5.3, sin el prefijo `allocations.N.` que Nest pone a los errores
 * anidados. El id del ítem lo valida `@IsUUID` en la línea (así lo descubre
 * el registro de ids por cuerpo, DX-207).
 */
export function allocationLinesError(
  value: unknown,
  mode: unknown,
): string | null {
  if (mode === 'AUTO')
    return value === undefined ? null : ALLOCATION_MODE_MISMATCH;
  if (mode !== 'MANUAL') return null;
  if (!Array.isArray(value)) return ALLOCATION_MODE_MISMATCH;
  if (value.length > MAX_ALLOCATION_LINES) return ALLOCATION_TOO_MANY_LINES;
  for (const line of value as unknown[]) {
    const { amount } = (line ?? {}) as Record<string, unknown>;
    if (!isMoneyAmount(amount)) return ALLOCATION_INVALID_AMOUNT;
  }
  return null;
}

function AllocationLines(): PropertyDecorator {
  return ValidateBy({
    name: 'allocationLines',
    validator: {
      validate: (value: unknown, args?: ValidationArguments): boolean =>
        allocationLinesError(
          value,
          (args?.object as { mode?: unknown } | undefined)?.mode,
        ) === null,
      defaultMessage: (args?: ValidationArguments): string =>
        allocationLinesError(
          args?.value,
          (args?.object as { mode?: unknown } | undefined)?.mode,
        ) ?? '',
    },
  });
}

export class ReplacePaymentAllocationsDto {
  @ApiProperty({
    pattern: '^[0-9a-f]{64}$',
    description: 'La `version` leída con GET; si cambió, 409',
  })
  @Matches(/^[0-9a-f]{64}$/, { message: ALLOCATION_VERSION_INVALID })
  expectedVersion!: string;

  @ApiProperty({
    enum: ALLOCATION_MODES,
    description:
      'MANUAL fija la imputación a las líneas enviadas; AUTO la devuelve al reparto automático',
  })
  @IsIn(ALLOCATION_MODES, { message: ALLOCATION_MODE_INVALID })
  mode!: AllocationMode;

  @ApiPropertyOptional({
    type: [ReplaceAllocationLineDto],
    maxItems: MAX_ALLOCATION_LINES,
    description:
      'Obligatorio con MANUAL (vacío = todo sin imputar); prohibido con AUTO',
  })
  @AllocationLines()
  @ValidateNested({ each: true })
  @Type(() => ReplaceAllocationLineDto)
  allocations?: ReplaceAllocationLineDto[];
}
