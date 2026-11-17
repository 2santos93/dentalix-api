import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import {
  LOCK_OVERRIDE_REASON_MAX,
  LOCK_OVERRIDE_REASON_MIN,
  LOCK_OVERRIDE_REASON_REQUIRED_MESSAGE,
} from '../../domain/financial-lock';

function trim({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * DX-091: `lockOverrideReason` de los cuerpos que pueden tocar un período
 * contable cerrado. El mínimo lo aplica la regla (`decideLock`) solo cuando
 * de verdad hace falta: fuera de un período cerrado el campo se ignora.
 */
export function LockOverrideReason(): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({
      minLength: LOCK_OVERRIDE_REASON_MIN,
      maxLength: LOCK_OVERRIDE_REASON_MAX,
      example:
        'Abono del 15/09 que recepción olvidó registrar; cuadrado con el extracto del banco',
      description:
        'DX-091: motivo para hacerlo en un período contable cerrado. Solo ' +
        'vale para ADMIN y si la clínica admite la exención ' +
        '(`financialLockAdminExempt`); entonces es obligatorio (3–300 ' +
        'caracteres, 400 sin él) y queda registrado con quién y cuándo. ' +
        'Para cualquier otro rol se ignora y el período cerrado da 409 ' +
        '`PERIOD_LOCKED`.',
    }),
    Transform(trim),
    IsOptional(),
    IsString({ message: LOCK_OVERRIDE_REASON_REQUIRED_MESSAGE }),
    MaxLength(LOCK_OVERRIDE_REASON_MAX, {
      message: LOCK_OVERRIDE_REASON_REQUIRED_MESSAGE,
    }),
  );
}
