import type { PhoneRegion } from '../../../shared/phone/phone-number';

/** Cuántos pacientes devuelve como máximo una búsqueda (un grupo familiar). Se piden 21 para saber si hay más. */
export const CALLER_LOOKUP_MAX_MATCHES = 20;

export type CallerMatchedBy = 'PATIENT' | 'RESPONSIBLE_PARTY';

export interface CallerMatch {
  patientId: string;
  firstName: string;
  lastName: string;
  /** Por su teléfono, o por el de alguno de sus responsables (DX-203; contacto o paciente). */
  matchedBy: CallerMatchedBy;
}

export interface CallerVisitRef {
  /** Inicio de la cita (instante UTC). */
  start: Date;
  locationId: string;
  locationName: string;
  /** Zona de la sede, para mostrar la hora donde ocurre. */
  timeZone: string;
}

export interface CallerNextAppointment extends CallerVisitRef {
  appointmentId: string;
}

export const CALLER_LOOKUP_REPOSITORY = Symbol('CALLER_LOOKUP_REPOSITORY');

/**
 * Todo bajo RLS y con las sedes del miembro (DX-089): citas y visitas solo de
 * las sedes que puede ver; el paciente es de la clínica entera.
 */
export interface CallerLookupRepository {
  /** Prefijo por defecto de la sede activa (o de la principal, sin sede activa). */
  defaultPhoneRegion(): Promise<PhoneRegion | null>;
  /** Pacientes vivos cuyo E.164 (o el de un responsable suyo) es alguno de `e164s`; como mucho `CALLER_LOOKUP_MAX_MATCHES`. */
  findByPhoneE164(
    e164s: readonly string[],
  ): Promise<{ matches: CallerMatch[]; truncated: boolean }>;
  /** La próxima cita (SCHEDULED o CONFIRMED, desde `now`) por paciente. */
  nextAppointments(
    patientIds: readonly string[],
    now: Date,
  ): Promise<Map<string, CallerNextAppointment>>;
  /** La última cita COMPLETED (hasta `now`) por paciente. */
  lastVisits(
    patientIds: readonly string[],
    now: Date,
  ): Promise<Map<string, CallerVisitRef>>;
}
