import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';

/**
 * DX-266: códigos que devuelve la BD (`dx_merge_patients`,
 * `dx_patient_merge_blockers`; SQLSTATE 'DX266', el código en el mensaje) y
 * lo que ve quien fusiona.
 */
export const MERGE_BLOCKER_CODES = [
  'DX266_OVERLAPPING_APPOINTMENTS',
  'DX266_OPENING_BALANCE_CONFLICT',
  'DX266_OPEN_PAYMENT_PROMISES',
] as const;

export type MergeBlockerCode = (typeof MERGE_BLOCKER_CODES)[number];

export const MERGE_BLOCKER_MESSAGES: Record<MergeBlockerCode, string> = {
  DX266_OVERLAPPING_APPOINTMENTS:
    'Los dos pacientes tienen citas a la misma hora. Cancela o mueve una de ellas antes de fusionar.',
  DX266_OPENING_BALANCE_CONFLICT:
    'Los dos pacientes tienen un saldo migrado del mismo lote de importación y en la misma moneda. Esos saldos no se pueden juntar.',
  DX266_OPEN_PAYMENT_PROMISES:
    'Los dos pacientes tienen un compromiso de pago abierto. Cierra uno de los dos antes de fusionar.',
};

/** Código del error de la API (en el cuerpo, `code`) de cada bloqueo. */
export const MERGE_BLOCKER_API_CODES: Record<MergeBlockerCode, string> = {
  DX266_OVERLAPPING_APPOINTMENTS: 'MERGE_OVERLAPPING_APPOINTMENTS',
  DX266_OPENING_BALANCE_CONFLICT: 'MERGE_OPENING_BALANCE_CONFLICT',
  DX266_OPEN_PAYMENT_PROMISES: 'MERGE_OPEN_PAYMENT_PROMISES',
};

export const MERGE_PATIENT_NOT_FOUND_MESSAGE = 'Paciente no encontrado';
export const MERGE_SAME_PATIENT_MESSAGE =
  'Elige dos pacientes distintos para fusionar.';
export const MERGE_INACTIVE_MESSAGE =
  'Uno de los dos pacientes ya está archivado o se fusionó con otro. Recarga la lista.';
export const MERGE_INACTIVE_CODE = 'MERGE_PATIENT_INACTIVE';

export function isMergeBlockerCode(code: string): code is MergeBlockerCode {
  return (MERGE_BLOCKER_CODES as readonly string[]).includes(code);
}

export function blockerException(code: MergeBlockerCode): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: MERGE_BLOCKER_API_CODES[code],
    message: MERGE_BLOCKER_MESSAGES[code],
  });
}

export function inactiveException(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: MERGE_INACTIVE_CODE,
    message: MERGE_INACTIVE_MESSAGE,
  });
}

/** El código DX266_* de un error de la BD, si lo es. */
export function dx266Code(error: unknown): string | null {
  const text =
    error instanceof Error
      ? `${error.message} ${JSON.stringify((error as { meta?: unknown }).meta ?? '')}`
      : String(error);
  return /DX266_[A-Z_]+/.exec(text)?.[0] ?? null;
}

/** Traduce un error de `dx_merge_patients` a la respuesta HTTP. */
export function mergeHttpError(code: string): HttpException {
  if (isMergeBlockerCode(code)) return blockerException(code);
  switch (code) {
    case 'DX266_NOT_FOUND':
      return new NotFoundException(MERGE_PATIENT_NOT_FOUND_MESSAGE);
    case 'DX266_SAME_PATIENT':
      return new BadRequestException(MERGE_SAME_PATIENT_MESSAGE);
    case 'DX266_PATIENT_INACTIVE':
      return inactiveException();
    default:
      return new ConflictException(
        'No se pudo fusionar a los pacientes. Vuelve a intentarlo.',
      );
  }
}
