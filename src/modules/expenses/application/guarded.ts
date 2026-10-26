import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ExpenseRuleError } from '../domain/expense-rules';

/** La regla rota, como la excepción HTTP con su mensaje en español. */
export function httpErrorOf(error: ExpenseRuleError): Error {
  switch (error.kind) {
    case 'NOT_FOUND':
      return new NotFoundException(error.message);
    case 'CONFLICT':
      return new ConflictException(error.message);
    default:
      return new BadRequestException(error.message);
  }
}

/** Ejecuta `fn` y traduce `ExpenseRuleError` a 400/404/409. */
export async function guarded<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ExpenseRuleError) throw httpErrorOf(error);
    throw error;
  }
}

/** Reglas puras síncronas (validaciones de campos): 400 con el mensaje. */
export function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ExpenseRuleError) throw httpErrorOf(error);
    throw error;
  }
}
