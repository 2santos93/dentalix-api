import { LockOverrideReason } from '../../../financial-lock/presentation/dto/lock-override-reason';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import {
  INPUT_NOTES_MAX,
  INPUT_REASON_MAX,
  TextMaxLength,
} from '../../../../shared/validation/input-limits';
import {
  IsNonNegativeMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';
import {
  DOWN_PAYMENT_MESSAGE,
  TOTAL_TO_FINANCE_MESSAGE,
} from '../../../../shared/money/currency-messages';

export class CreatePaymentPlanDto {
  @ApiProperty({
    example: 12,
    description: 'Número de cuotas, entero >= 1 y <= 600',
  })
  @IsInt()
  @Min(1)
  @Max(600)
  installmentsCount!: number;

  @ApiProperty({ enum: ['WEEKLY', 'BIWEEKLY', 'MONTHLY'] })
  @IsIn(['WEEKLY', 'BIWEEKLY', 'MONTHLY'])
  periodicity!: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Fecha de la 1ª cuota',
  })
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({
    example: 200,
    description: 'Pie/abono inicial esperado (>= 0, como mucho 2 decimales)',
    maximum: MONEY_MAX,
  })
  @IsOptional()
  @IsNonNegativeMoney(DOWN_PAYMENT_MESSAGE)
  downPayment?: number;

  @ApiPropertyOptional({
    example: 1200,
    description:
      'Monto total a financiar (como mucho 2 decimales). Default = saldo actual del plan.',
    maximum: MONEY_MAX,
  })
  @IsOptional()
  @IsNonNegativeMoney(TOTAL_TO_FINANCE_MESSAGE)
  totalToFinance?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_NOTES_MAX)
  notes?: string;

  @LockOverrideReason()
  lockOverrideReason?: string;
}

/** Mismos límites que el motivo de anular un abono (`VoidPaymentDto`). */
export const CANCEL_REASON_MIN = 3;
export const CANCEL_REASON_MAX = 300;

function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Cuerpo de DELETE /treatment-plans/:id/payment-plan. DX-092 (SEC-029): el
 * motivo es obligatorio, como al anular un abono (DX-049); quién cancela sale
 * del token y cuándo, del reloj del servidor — nunca del cliente.
 */
export class CancelPaymentPlanDto {
  @ApiProperty({
    minLength: CANCEL_REASON_MIN,
    maxLength: CANCEL_REASON_MAX,
    example: 'El paciente pagará el saldo de contado',
    description:
      'Motivo de la cancelación (3–300 caracteres tras quitar espacios). Queda ' +
      'guardado junto a quién y cuándo canceló.',
  })
  @Transform(trim)
  @IsString({ message: 'Indica el motivo de la cancelación.' })
  @Length(CANCEL_REASON_MIN, CANCEL_REASON_MAX, {
    message: `El motivo de la cancelación debe tener entre ${CANCEL_REASON_MIN} y ${CANCEL_REASON_MAX} caracteres.`,
  })
  @TextMaxLength(INPUT_REASON_MAX)
  reason!: string;

  /** DX-091: motivo del ADMIN para cancelarlo en un período cerrado. */
  @LockOverrideReason()
  lockOverrideReason?: string;
}
