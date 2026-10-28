import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { RegionalFormat } from '../../../shared/format/regional-format';
import {
  HOLIDAY_MESSAGES,
  type HolidayConflict,
  type HolidayRuleError,
} from './holiday-rules';

/** Errores HTTP del calendario de la sede (spec §6), con el cuerpo de G1. */

/** 404: la sede no existe, es de otra clínica o está retirada. */
export function locationNotFound(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    code: 'LOCATION_NOT_FOUND',
    message: HOLIDAY_MESSAGES.locationNotFound,
  });
}

/** 404: el festivo no existe, está retirado o es de otra sede. */
export function holidayNotFound(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    code: 'HOLIDAY_NOT_FOUND',
    message: HOLIDAY_MESSAGES.holidayNotFound,
  });
}

const CONFLICT_MESSAGES: Record<HolidayConflict, (name: string) => string> = {
  SAME: HOLIDAY_MESSAGES.sameKeyConflict,
  ONE_OFF_ON_RECURRING: HOLIDAY_MESSAGES.oneOffOnRecurring,
  RECURRING_ON_ONE_OFF: HOLIDAY_MESSAGES.recurringOnOneOff,
};

/** 409 R5: el día ya es festivo de la sede; `holidayId` es el que ocupa el día. */
export function holidayAlreadyExists(
  existing: { id: string; name: string },
  conflict: HolidayConflict,
): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'HOLIDAY_ALREADY_EXISTS',
    message: CONFLICT_MESSAGES[conflict](existing.name),
    holidayId: existing.id,
  });
}

/**
 * 409 `LOCATION_HOLIDAY_LIMIT` (§5.1): la sede ya tiene el máximo de festivos
 * vivos. La cifra sale con el formato de la sede (G1-B).
 */
export function holidayLimitReached(fmt: RegionalFormat): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'LOCATION_HOLIDAY_LIMIT',
    message: HOLIDAY_MESSAGES.locationLimit(fmt),
  });
}

/** 400 con el texto de la regla y el campo, como `regionalBadRequest` (G1). */
export function holidayBadRequest(
  error: HolidayRuleError,
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: error.message,
    field: error.field,
  });
}
