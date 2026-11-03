import { ConflictException } from '@nestjs/common';
import type { RegionalFormat } from '../../../shared/format/regional-format';
import { requireLocationFormat } from '../../../shared/locations/location-regional';
import { locationRequired } from '../../../shared/locations/reference-location';
import type { PatientRetentionState } from '../domain/ports/patient-repository.port';
import {
  isUnderRetention,
  retentionUntil,
  type RetentionBasis,
  type RetentionEnd,
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
 * Mensaje en español con la fecha hasta la que se conserva la HC. El motivo
 * entre paréntesis sigue a lo que dio la fecha: con DOUBLE el doble del plazo
 * de la clínica (`years`), y con el suelo el plazo anterior, porque decir el
 * plazo de hoy contradiría la fecha. La fecha sale con el formato de la sede
 * principal (DX-354); `fmt` es perezoso: «permanente» no lleva fecha.
 */
export function retentionMessage(
  until: Date | 'PERMANENT',
  basis: RetentionBasis,
  years: number,
  fmt: () => RegionalFormat,
): string {
  if (until === 'PERMANENT') {
    return 'La historia clínica de este paciente tiene retención permanente: no se puede archivar ni borrar. Si necesitas retirar sus datos de contacto, usa la supresión parcial.';
  }
  const reason =
    basis === 'PREVIOUS_TERM'
      ? 'plazo anterior de la clínica'
      : basis === 'DOUBLE'
        ? `plazo doble: ${2 * years} años desde la última atención`
        : `${years} años desde la última atención`;
  return `La historia clínica de este paciente está en retención hasta el ${fmt().civilDate(until.toISOString().slice(0, 10))} (${reason}): no se puede archivar ni borrar. Si necesitas retirar sus datos de contacto, usa la supresión parcial.`;
}

/**
 * El formato de la sede principal de la clínica (R6) con el que se escribe la
 * fecha: sin sede activa, 409 `LOCATION_REQUIRED`; sin formato o reloj, 409
 * `LOCATION_LOCALE_REQUIRED`. Nunca otro formato.
 */
function retentionFormat(state: PatientRetentionState): RegionalFormat {
  if (!state.format) throw locationRequired();
  return requireLocationFormat(state.format);
}

function retentionEnd(state: PatientRetentionState): RetentionEnd {
  return retentionUntil(
    state.lastAttentionAt,
    state.retentionExtended,
    state.years,
    state.retentionFloorUntil,
  );
}

/**
 * Regla de dominio de DX-039: mientras la HC esté en retención, ni el
 * paciente ni sus entradas clínicas se archivan o borran. 409 con un código
 * estable para que el cliente lo distinga de otros conflictos.
 */
export function assertNotUnderRetention(
  state: PatientRetentionState,
  now: Date,
): void {
  const { until, basis } = retentionEnd(state);
  if (until === null || basis === null || !isUnderRetention(until, now)) return;
  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: CLINICAL_RECORD_RETENTION,
    message: retentionMessage(until, basis, state.years, () =>
      retentionFormat(state),
    ),
    retentionUntil:
      until === 'PERMANENT' ? null : until.toISOString().slice(0, 10),
  });
}

/** La supresión parcial solo tiene sentido con la HC en retención. */
export function assertUnderRetention(
  state: PatientRetentionState,
  now: Date,
): void {
  const { until } = retentionEnd(state);
  if (until !== null && isUnderRetention(until, now)) return;
  throw new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: NOT_UNDER_RETENTION,
    message:
      'La historia clínica de este paciente no está en retención: no hace falta la supresión parcial, puedes archivar al paciente.',
  });
}
