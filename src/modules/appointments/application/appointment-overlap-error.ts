import { Prisma } from '@prisma/client';

/** Qué recurso quedó doble-agendado: el profesional o el paciente. */
export type OverlapScope = 'provider' | 'patient';

const CONSTRAINT_NAMES: Record<OverlapScope, string> = {
  provider: 'appointments_no_overlap_per_provider',
  patient: 'appointments_no_overlap_per_patient',
};

/**
 * Mensaje 409 por ámbito. Vive acá (y no duplicado en cada use-case) para que el
 * pre-check y el backstop de la constraint respondan EXACTAMENTE lo mismo: al
 * usuario le da igual si el conflicto lo detectó la app o la DB.
 */
export const OVERLAP_MESSAGES: Record<OverlapScope, string> = {
  provider: 'El profesional ya tiene una cita en ese horario',
  patient: 'El paciente ya tiene otra cita en ese horario',
};

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
