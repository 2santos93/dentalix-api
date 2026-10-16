import { ConflictException } from '@nestjs/common';
import type { RetentionExtension } from '@prisma/client';
import type { PatientRetentionState } from '../domain/ports/patient-repository.port';
import {
  formatRetentionDate,
  isUnderRetention,
  retentionUntil,
} from '../domain/retention/clinical-record-retention';

export const CLINICAL_RECORD_RETENTION = 'CLINICAL_RECORD_RETENTION';
export const NOT_UNDER_RETENTION = 'NOT_UNDER_RETENTION';
export const PATIENT_HAS_PENDING_APPOINTMENTS =
  'PATIENT_HAS_PENDING_APPOINTMENTS';

/**
 * Un paciente con citas abiertas (programadas o confirmadas) no se archiva:
 * seguirían en la agenda y en los recordatorios con una ficha que ya no
 * existe. Hay que cancelarlas o cerrarlas antes.
 */
export function assertNoPendingAppointments(pendingAppointments: number): void {
  if (pendingAppointments === 0) return;
  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: PATIENT_HAS_PENDING_APPOINTMENTS,
    message:
      pendingAppointments === 1
        ? 'Este paciente tiene 1 cita programada o confirmada: cancélala o márcala como atendida o no asistida antes de archivarlo.'
        : `Este paciente tiene ${pendingAppointments} citas programadas o confirmadas: cancélalas o márcalas como atendidas o no asistidas antes de archivarlo.`,
    pendingAppointments,
  });
}

/**
 * Mensaje en español con la fecha hasta la que se conserva la HC. La base
 * legal entre paréntesis sigue al plazo: con DOUBLE la fecha es a 30 años y
 * decir «15 años» contradiría la fecha.
 */
export function retentionMessage(
  until: Date | 'PERMANENT',
  extension: RetentionExtension = 'NONE',
): string {
  if (until === 'PERMANENT') {
    return 'La historia clínica de este paciente tiene retención legal permanente: no se puede archivar ni borrar. Si necesitas retirar sus datos de contacto, usa la supresión parcial.';
  }
  const basis =
    extension === 'DOUBLE'
      ? 'plazo doble: 30 años desde la última atención'
      : 'Res. 839/2017: 15 años desde la última atención';
  return `La historia clínica de este paciente está en retención legal hasta el ${formatRetentionDate(until)} (${basis}): no se puede archivar ni borrar. Si necesitas retirar sus datos de contacto, usa la supresión parcial.`;
}

/**
 * Regla de dominio de DX-039: mientras la HC esté en retención legal, ni el
 * paciente ni sus entradas clínicas se archivan o borran. 409 con un código
 * estable para que el cliente lo distinga de otros conflictos.
 */
export function assertNotUnderRetention(
  state: PatientRetentionState,
  now: Date,
): void {
  const until = retentionUntil(state.lastAttentionAt, state.retentionExtended);
  if (until === null || !isUnderRetention(until, now)) return;
  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: CLINICAL_RECORD_RETENTION,
    message: retentionMessage(until, state.retentionExtended),
    retentionUntil:
      until === 'PERMANENT' ? null : until.toISOString().slice(0, 10),
  });
}

/** La supresión parcial solo tiene sentido con la HC en retención. */
export function assertUnderRetention(
  state: PatientRetentionState,
  now: Date,
): void {
  const until = retentionUntil(state.lastAttentionAt, state.retentionExtended);
  if (until !== null && isUnderRetention(until, now)) return;
  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: NOT_UNDER_RETENTION,
    message:
      'La historia clínica de este paciente no está en retención legal: no hace falta la supresión parcial, puedes archivar al paciente.',
  });
}
