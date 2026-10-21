import type {
  MinuteRange,
  ProviderOverride,
  ProviderScheduleSnapshot,
  WeeklyProviderRange,
} from '../provider-availability';

export const PROVIDER_SCHEDULE_REPOSITORY = Symbol(
  'PROVIDER_SCHEDULE_REPOSITORY',
);

/** Período de días civiles, ambos incluidos (YYYY-MM-DD). */
export interface CivilPeriod {
  from: string;
  to: string;
}

/** El horario semanal de una sede tal como se guarda. */
export interface WeeklyLocationWrite {
  locationId: string;
  /** Zona vigente de la sede (informativa en la fila). */
  timezone: string;
  ranges: { weekday: number; startMinute: number; endMinute: number }[];
}

export interface ReplaceWeeklyInput {
  providerId: string;
  locations: WeeklyLocationWrite[];
  actorId: string;
  /**
   * Se llama DENTRO de la transacción, con el candado del profesional, con lo
   * que hay guardado (semanal y excepciones desde `overridesFrom`). Si lanza,
   * no se escribe nada: así dos guardados a la vez no se saltan la regla.
   */
  validate: (current: ProviderScheduleSnapshot) => void;
  overridesFrom: string;
}

export interface UpsertOverrideInput {
  providerId: string;
  locationId: string;
  date: string;
  ranges: MinuteRange[];
  note: string | null;
  actorId: string;
  /** Igual que en `ReplaceWeeklyInput`, con las excepciones de esa fecha. */
  validate: (current: ProviderScheduleSnapshot) => void;
}

export interface WeeklyChange {
  before: WeeklyProviderRange[];
  after: WeeklyProviderRange[];
}

export interface OverrideChange {
  before: ProviderOverride | null;
  after: ProviderOverride;
}

export interface ProviderScheduleRepository {
  /**
   * Horario de cada profesional pedido: semanal vivo y excepciones vivas del
   * período (todas desde `period.from` si no hay `to`). Un profesional sin
   * nada sale con `configured: false`. Bajo RLS.
   */
  findSnapshots(
    providerIds: readonly string[],
    period: CivilPeriod,
  ): Promise<Map<string, ProviderScheduleSnapshot>>;

  /** Reemplaza TODO el semanal del profesional (todas sus sedes). */
  replaceWeekly(input: ReplaceWeeklyInput): Promise<WeeklyChange>;

  /** Crea la excepción de esa sede y fecha, o reemplaza la viva. */
  upsertOverride(input: UpsertOverrideInput): Promise<OverrideChange>;

  /** Retira (en blando) una excepción viva; `null` si no existe. */
  deleteOverride(
    providerId: string,
    overrideId: string,
  ): Promise<ProviderOverride | null>;

  /** Excepciones vivas del profesional en el período, por fecha. */
  listOverrides(
    providerId: string,
    period: CivilPeriod,
  ): Promise<ProviderOverride[]>;

  /** Modo estricto de la clínica (`tenants.providerScheduleStrict`). */
  getStrict(): Promise<boolean>;
  setStrict(strict: boolean): Promise<boolean>;

  /**
   * Sede EN CONTEXTO (cabecera `X-Location-Id` o, sin ella, la de escritura
   * de la sesión: DX-089), la misma resolución con la que el repositorio de
   * citas escribe la cita.
   */
  resolveCurrentLocationId(): Promise<string>;
}
