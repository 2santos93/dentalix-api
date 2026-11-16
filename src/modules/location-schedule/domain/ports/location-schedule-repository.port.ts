import type { LocationFormatSource } from '../../../../shared/locations/location-regional';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { BusinessHours, ScheduleRange } from '../../application/business-hours';

export const LOCATION_SCHEDULE_REPOSITORY = Symbol(
  'LOCATION_SCHEDULE_REPOSITORY',
);

/**
 * G1 fase 1 (R15): una web antigua todavía envía `timezone` en el `PUT`. Se
 * acepta solo si es la zona de la sede; nunca se guarda desde el cuerpo.
 */
export const SCHEDULE_TIME_ZONE_MOVED =
  'La zona horaria ya no se guarda en el horario: es un dato de la sede (Ajustes → Sedes).';

export interface ReplaceScheduleInput {
  ranges: ScheduleRange[];
  /** `timezone` del cuerpo de una web antigua (R15), sin guardar. */
  legacyTimeZone?: string;
}

/** DX-263-bis: un festivo vivo de la sede (DX-316); `date` 'YYYY-MM-DD'. */
export interface LocationHolidayEntry {
  date: string;
  name: string;
  recurring: boolean;
}

/**
 * DX-263-bis: los festivos vivos de una sede y la zona en la que se leen.
 * `timeZone` es null solo si la sede no tiene festivos (no hace falta zona).
 */
export interface LocationHolidays {
  timeZone: string | null;
  holidays: LocationHolidayEntry[];
}

export interface LocationScheduleRepository {
  /**
   * El horario de la sede indicada, o `null` si esa sede no tiene horario
   * configurado — que el dominio interpreta como "sin restricción" (ver
   * `fitsBusinessHours`). Tenant-scoped (RLS / `runWithTenant`).
   *
   * `timezone` es SIEMPRE `Location.timeZone` (G1, R4); sin una zona válida,
   * 409 `LOCATION_TIMEZONE_REQUIRED`.
   */
  findByLocation(locationId: string): Promise<BusinessHours | null>;

  /**
   * El horario de la sede EN CONTEXTO (cabecera `X-Location-Id` si vino, si no la
   * sede por defecto) — exactamente la misma resolución que usa
   * `PrismaAppointmentRepository.create` para decidir en qué sede se escribe la
   * cita. Comparten resolución a propósito: validar contra el horario de una sede
   * y escribir la cita en otra sería una validación que miente.
   *
   * Cuando la Fase 2 de multi-sede haga la cabecera obligatoria y elimine
   * `resolveDefaultLocationId`, este método se simplifica con el resto.
   */
  findForCurrentLocation(): Promise<BusinessHours | null>;

  /**
   * DX-354: lo que `requireLocationFormat` pide de la sede (formato y reloj)
   * para escribir las horas de un mensaje con SU formato. `locationId`
   * indefinido = la sede en contexto, la misma de `findForCurrentLocation`.
   * No lanza por falta de formato: quien formatea llama a
   * `requireLocationFormat` (409 `LOCATION_LOCALE_REQUIRED`) solo si hay horas
   * que escribir.
   */
  formatSourceOf(locationId?: string): Promise<LocationFormatSource>;

  /**
   * DX-263-bis: los festivos vivos (DX-316) de la sede indicada o, con
   * `locationId` indefinido, de la sede en contexto (la misma de
   * `findForCurrentLocation`, donde se escribe la cita). Con festivos y sin
   * zona válida, 409 `LOCATION_TIMEZONE_REQUIRED`; sin festivos no se pide
   * la zona (no cambia nada para quien no usa el calendario).
   */
  holidaysOf(locationId?: string): Promise<LocationHolidays>;

  /**
   * Reemplaza TODA la semana de la sede en contexto (semántica atómica simple
   * para una grilla: el cliente manda el horario completo, no parches por día).
   * Crea la fila de configuración si no existía, con la columna legada
   * `timezone` igual a la zona de la sede (R20). Con `legacyTimeZone` distinto
   * de esa zona (o sede sin zona), 400 `SCHEDULE_TIME_ZONE_MOVED` (R15).
   * DX-360: si la semana cambia, deja su evento (LOCATION_SCHEDULE) en la
   * misma transacción.
   */
  replaceForCurrentLocation(
    input: ReplaceScheduleInput,
    audit: AuditRequestContext,
  ): Promise<BusinessHours>;
}
