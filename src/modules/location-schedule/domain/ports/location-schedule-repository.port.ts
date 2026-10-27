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
   * Reemplaza TODA la semana de la sede en contexto (semántica atómica simple
   * para una grilla: el cliente manda el horario completo, no parches por día).
   * Crea la fila de configuración si no existía, con la columna legada
   * `timezone` igual a la zona de la sede (R20). Con `legacyTimeZone` distinto
   * de esa zona (o sede sin zona), 400 `SCHEDULE_TIME_ZONE_MOVED` (R15).
   */
  replaceForCurrentLocation(
    input: ReplaceScheduleInput,
  ): Promise<BusinessHours>;
}
