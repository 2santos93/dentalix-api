import type { AppointmentStatus } from '@prisma/client';
import type { HourCycle } from '../../../../shared/format/regional-format';
import type { CheckInSettings } from '../check-in-rules';
import type { CheckInAttemptState } from '../check-in-identity';

// Sin `tenantId` en ningún input: el tenant sale SIEMPRE del contexto (JWT +
// host en Ajustes, solo host en las rutas públicas) y la RLS acota.

/** Los ajustes de una sede tal como los ve Ajustes (con los valores por defecto). */
export interface LocationCheckInSettingsView extends CheckInSettings {
  locationId: string;
  /** Hay un QR activo, y desde cuándo (el token no se vuelve a ver). */
  qrActive: boolean;
  qrCreatedAt: Date | null;
}

/** La sede del QR, para la página pública. */
export interface CheckInQrLocation {
  locationId: string;
  locationName: string;
  timeZone: string | null;
  locale: string | null;
  hourCycle: HourCycle | null;
}

/** La cita a la que se marca la llegada (por id, ya resuelta por el enlace o el QR). */
export interface ArrivalAppointment {
  id: string;
  patientId: string;
  locationId: string;
  start: Date;
  status: AppointmentStatus;
  arrivedAt: Date | null;
  turnNumber: number | null;
  patientFirstName: string | null;
  locationName: string;
  timeZone: string | null;
  locale: string | null;
  hourCycle: HourCycle | null;
}

/** Una cita de hoy en la sede del QR con lo justo para identificar al paciente. */
export interface IdentificationCandidate {
  appointmentId: string;
  start: Date;
  status: AppointmentStatus;
  docNumber: string | null;
  /** Día civil AAAA-MM-DD o null. */
  birthDate: string | null;
}

/** Lo que el triaje lee del paciente (nada clínico). */
export interface PendingPatientFacts {
  patientId: string;
  /** Falta documento, fecha de nacimiento o teléfono. */
  missingData: boolean;
  /** Sin autorización de datos (general o de salud) o con una firma a distancia de consentimiento sin firmar. */
  consentPending: boolean;
}

export const CHECK_IN_REPOSITORY = Symbol('CHECK_IN_REPOSITORY');

export interface CheckInRepository {
  /** Ajustes guardados de la sede o `null` (valores por defecto, sin QR). */
  findSettings(locationId: string): Promise<LocationCheckInSettingsView | null>;

  /** Guarda (crea o cambia) los ajustes de la sede. */
  saveSettings(
    locationId: string,
    patch: Partial<CheckInSettings>,
    actorId: string,
  ): Promise<LocationCheckInSettingsView>;

  /** Pone (hash) o quita (`null`) el QR de la sede; el anterior deja de valer. */
  setQrToken(
    locationId: string,
    tokenHash: string | null,
    actorId: string,
  ): Promise<LocationCheckInSettingsView>;

  /** La sede activa del QR (por su hash), o `null` (desconocido, revocado, otra clínica). */
  findQrLocation(
    tokenHash: string,
  ): Promise<(CheckInQrLocation & { settings: CheckInSettings }) | null>;

  findArrivalAppointment(
    appointmentId: string,
  ): Promise<ArrivalAppointment | null>;

  /** Citas vivas de la sede con inicio en `[from, to)`, con documento y fecha del paciente. */
  identificationCandidates(
    locationId: string,
    from: Date,
    to: Date,
  ): Promise<IdentificationCandidate[]>;

  /** Estado del contador de fallos de un cliente en la sede, o `null`. */
  findAttempts(
    locationId: string,
    clientKey: string,
  ): Promise<CheckInAttemptState | null>;

  /**
   * Anota un intento ANTES de comparar (atómico: INSERT … ON CONFLICT DO
   * UPDATE … RETURNING). Los de más de `windowMinutes` o tras un bloqueo
   * vencido empiezan de cero; pasado `maxAttempts`, bloquea `lockMinutes`.
   */
  reserveAttempt(
    locationId: string,
    clientKey: string,
    rules: { maxAttempts: number; lockMinutes: number; windowMinutes: number },
  ): Promise<CheckInAttemptState>;

  /** El fallo que llega al tope bloquea al cliente; devuelve hasta cuándo. */
  lockClient(
    locationId: string,
    clientKey: string,
    lockMinutes: number,
  ): Promise<Date>;

  /**
   * Un acierto devuelve SOLO su propio intento (nunca borra el contador ni un
   * bloqueo): acertar con los datos propios no limpia los fallos ajenos.
   */
  refundAttempt(locationId: string, clientKey: string): Promise<void>;

  pendingFacts(
    patientIds: readonly string[],
    now: Date,
  ): Promise<Map<string, PendingPatientFacts>>;
}
