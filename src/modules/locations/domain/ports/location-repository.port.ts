import type { ClinicCountry } from '@prisma/client';
import type { HourCycle } from '../regional-settings';

export interface Location {
  id: string;
  tenantId: string;
  name: string;
  address: string | null;
  /** País de la sede (DX-013): decide los campos legales de la receta. */
  country: ClinicCountry;
  /** DX-319: nº de registro sanitario (texto libre) o null. */
  healthRegistrationNumber: string | null;
  /** DX-319: si el nº sale en los documentos de la sede. */
  showHealthRegistrationNumber: boolean;
  /** DX-222: teléfono de la sede para las indicaciones postoperatorias, o null. */
  phone: string | null;
  isActive: boolean;
  /**
   * G1: moneda ISO 4217, zona IANA y locale BCP 47 de la sede. La zona es la
   * única fuente de sus días civiles (DX-097, R4). `null` solo en fase 1, en
   * una fila de una réplica anterior a G1 aún sin barrer: «sede sin
   * configurar», nunca se rellena con un valor del país (R19).
   */
  currency: string | null;
  timeZone: string | null;
  locale: string | null;
  /**
   * G1-B: reloj de la sede, `'h12'` | `'h23'` (CHECK de la BD). `null` solo en
   * fase 1, en una fila de una réplica de G1 aún sin barrer; solo lo rellena
   * `dx_g1b_backfill_location_hour_cycle`.
   */
  hourCycle: string | null;
  /** D5: null = valores asignados por la migración o el barrido, sin revisar. */
  regionalSettingsReviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// NOTA: sin `tenantId` — el tenant sale del contexto del request, nunca del
// cliente (misma convención que CreatePaymentRepoInput).
export interface CreateLocationRepoInput {
  name: string;
  address?: string;
  /** G1 (R1, R10): los cuatro, explícitos y ya validados. */
  country: ClinicCountry;
  currency: string;
  timeZone: string;
  locale: string;
  /**
   * G1-B fase 1: null = alta de la web de G1 sin reloj; el repositorio llama a
   * la función de backfill en la misma transacción.
   */
  hourCycle: HourCycle | null;
  phone?: string;
}

export interface UpdateLocationRepoInput {
  name?: string;
  address?: string;
  country?: ClinicCountry;
  /** DX-319: ya recortado; null lo quita. */
  healthRegistrationNumber?: string | null;
  showHealthRegistrationNumber?: boolean;
  /** DX-222: ya recortado; null lo quita. */
  phone?: string | null;
  isActive?: boolean;
}

/**
 * Lo que ve la decisión regional dentro de la transacción que ya tiene la fila
 * de la sede bloqueada (`FOR UPDATE`): la sede tal como está, si hay una caja
 * ABIERTA y si tiene historial (citas, abonos, gastos y salidas de caja,
 * inventario, cajas, listas de precios o versiones de política).
 */
export interface RegionalWriteContext {
  current: Location;
  hasOpenCashSession(): Promise<boolean>;
  hasRegionalHistory(): Promise<boolean>;
}

/** Valores regionales ya validados a escribir, y si la sede queda revisada. */
export interface RegionalWrite {
  currency?: string;
  timeZone?: string;
  locale?: string;
  hourCycle?: HourCycle;
  reviewed: boolean;
}

export const LOCATION_REPOSITORY = Symbol('LOCATION_REPOSITORY');

export interface LocationRepository {
  create(input: CreateLocationRepoInput): Promise<Location>;
  /** Sedes no borradas del tenant, ordenadas por fecha de creación. */
  list(): Promise<Location[]>;
  findById(id: string): Promise<Location | null>;
  update(id: string, patch: UpdateLocationRepoInput): Promise<Location | null>;
  /**
   * Edición con campos regionales (G1, spec §3.2): en UNA transacción bloquea
   * la sede (`SELECT … FOR UPDATE`, para que no se abra una caja entre la
   * comprobación y la escritura), llama a `decide` (que puede lanzar 409) y
   * escribe `patch` + lo regional. Si cambia la zona, actualiza en la misma
   * transacción `location_schedules.timezone` (R20). null = la sede no existe.
   */
  updateRegional(
    id: string,
    patch: UpdateLocationRepoInput,
    decide: (ctx: RegionalWriteContext) => Promise<RegionalWrite>,
  ): Promise<Location | null>;
  /** Cuántas sedes ACTIVAS quedan — para no dejar la clínica sin ninguna. */
  countActive(): Promise<number>;
  /** ¿Hay operaciones (citas/pagos/inventario) atadas a esta sede? */
  hasOperations(id: string): Promise<boolean>;
}
