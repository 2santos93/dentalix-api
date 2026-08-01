import { BusinessHours, ScheduleRange } from '../../application/business-hours';

export const LOCATION_SCHEDULE_REPOSITORY = Symbol(
  'LOCATION_SCHEDULE_REPOSITORY',
);

export interface ReplaceScheduleInput {
  timezone: string;
  ranges: ScheduleRange[];
}

export interface LocationScheduleRepository {
  /**
   * El horario de la sede indicada, o `null` si esa sede no tiene horario
   * configurado — que el dominio interpreta como "sin restricción" (ver
   * `fitsBusinessHours`). Tenant-scoped (RLS / `runWithTenant`).
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
   * Crea la fila de configuración si no existía.
   */
  replaceForCurrentLocation(
    input: ReplaceScheduleInput,
  ): Promise<BusinessHours>;
}
