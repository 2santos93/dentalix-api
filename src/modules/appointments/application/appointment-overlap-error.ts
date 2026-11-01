import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Qué recurso quedó doble-agendado: el profesional, el paciente o (DX-211) el
 * sillón.
 */
export type OverlapScope = 'provider' | 'patient' | 'chair';

const CONSTRAINT_NAMES: Record<OverlapScope, string> = {
  provider: 'appointments_no_overlap_per_provider',
  patient: 'appointments_no_overlap_per_patient',
  chair: 'appointments_no_overlap_per_chair',
};

/**
 * Mensaje 409 por ámbito. Vive acá (y no duplicado en cada use-case) para que el
 * pre-check y el backstop de la constraint respondan EXACTAMENTE lo mismo: al
 * usuario le da igual si el conflicto lo detectó la app o la DB.
 */
export const OVERLAP_MESSAGES: Record<
  Exclude<OverlapScope, 'chair'>,
  string
> = {
  provider: 'El profesional ya tiene una cita en ese horario',
  patient: 'El paciente ya tiene otra cita en ese horario',
};

/**
 * DX-509-bis: código del 409 de solape al MOVER una cita (profesional o
 * paciente). Con él la web distingue «ese hueco está ocupado» de los demás 409
 * (paciente en la clínica, ítem cerrado...) y ofrece el siguiente hueco libre.
 */
export const APPOINTMENT_OVERLAP_CODE = 'APPOINTMENT_OVERLAP';

/** El 409 de solape con su código y ámbito; el mensaje es el de siempre. */
export function overlapConflict(
  scope: Exclude<OverlapScope, 'chair'>,
): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: APPOINTMENT_OVERLAP_CODE,
    scope,
    message: OVERLAP_MESSAGES[scope],
  });
}

/**
 * Devuelve el ÁMBITO de la exclusion-constraint de Postgres (SQLSTATE 23P01)
 * que rechazó el INSERT/UPDATE, o `null` si el error no es una violación de
 * exclusión. Son las garantías a nivel DB contra doble-agendado: cierran la
 * carrera check-then-insert que los pre-checks `findOverlapping*` por sí solos
 * no pueden (dos escrituras concurrentes pueden pasar ambos pre-checks y
 * colisionar solo al escribir).
 *
 * Prisma expone el 23P01 en DOS formas (ambas cubiertas):
 *  - ORM `tx.appointment.create()/update()` (lo que usa el repo): un
 *    `PrismaClientUnknownRequestError` SIN `.code`/`.meta`; el SQLSTATE `23P01`
 *    y el nombre de la constraint aparecen solo dentro de `.message`. El filtro
 *    global `PrismaExceptionFilter` (`@Catch(PrismaClientKnownRequestError)`,
 *    solo P2002) NO lo atrapa — de ahí que los use-cases lo mapeen explícito.
 *  - raw `$executeRaw` (defensivo/a futuro): un
 *    `PrismaClientKnownRequestError` code `P2010` con `meta.code === '23P01'`.
 *
 * Si es un 23P01 pero no se reconoce el nombre de la constraint (p. ej. el shape
 * raw, que no lo incluye), se asume `'provider'`: era la única constraint de
 * exclusión que existía, así que el comportamiento previo no cambia.
 */
export function overlapExclusionScope(error: unknown): OverlapScope | null {
  const message = exclusionViolationMessage(error);
  if (message === null) {
    return null;
  }
  if (message.includes(CONSTRAINT_NAMES.patient)) {
    return 'patient';
  }
  // DX-211: el 409 del sillón lleva su nombre y horas (ChairAssignmentService).
  if (message.includes(CONSTRAINT_NAMES.chair)) {
    return 'chair';
  }
  return 'provider';
}

/** El `message` del error si es una violación 23P01; `null` si no lo es. */
function exclusionViolationMessage(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return error.message.includes('23P01') ? error.message : null;
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2010'
  ) {
    const meta = error.meta as { code?: string } | undefined;
    if (meta?.code === '23P01' || error.message.includes('23P01')) {
      return error.message;
    }
  }
  return null;
}
