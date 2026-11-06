import { ClinicRole } from '@prisma/client';
import type { AllowedLocations } from '../../../shared/tenancy/location-access';
import type { WorkQueueKey, WorkQueuesSummary } from '../domain/work-queues';

/**
 * OPS-056: cuánto vale un resumen de «Mi día». La web lo pide cada 60 s por
 * pestaña visible; con 30 s, las pestañas de un mismo usuario comparten el
 * cálculo y ningún número envejece más de medio minuto.
 */
export const WORK_QUEUES_CACHE_TTL_MS = 30_000;

/** Tope de entradas por réplica (una por usuario, sede y juego de listas). */
export const WORK_QUEUES_CACHE_MAX_ENTRIES = 5_000;

/** Todo lo que decide el contenido de un resumen. */
export interface WorkQueuesCacheScope {
  tenantId: string;
  /** Sede activa; `undefined` = vista de las sedes permitidas. */
  locationId: string | undefined;
  allowedLocationIds: AllowedLocations;
  role: ClinicRole;
  userId: string;
  /** Las listas pedidas, ya acotadas al rol y en el orden de la bandeja. */
  keys: readonly WorkQueueKey[];
}

/**
 * La clave lleva la clínica, la sede activa, las sedes permitidas, el rol, el
 * usuario y las listas: dos peticiones comparten resumen solo si TODO eso
 * coincide. Va como JSON de una tupla, así ningún id puede hacerse pasar por
 * otro campo.
 */
export function workQueuesCacheKey(scope: WorkQueuesCacheScope): string {
  const allowed =
    scope.allowedLocationIds === 'ALL'
      ? 'ALL'
      : [...scope.allowedLocationIds].sort();
  return JSON.stringify([
    scope.tenantId,
    scope.locationId ?? null,
    allowed,
    scope.role,
    scope.userId,
    scope.keys,
  ]);
}

interface Entry {
  value: WorkQueuesSummary;
  expiresAt: number;
}

/**
 * Caché en memoria de la réplica, con TTL y acotada. No se comparte entre
 * réplicas: cada una calcula lo suyo como mucho una vez por TTL y clave.
 */
export class WorkQueuesSummaryCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number,
    private readonly nowMs: () => number,
    private readonly maxEntries = WORK_QUEUES_CACHE_MAX_ENTRIES,
  ) {}

  get(key: string): WorkQueuesSummary | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.nowMs()) {
      this.drop(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: WorkQueuesSummary): void {
    if (this.ttlMs <= 0) return;
    const now = this.nowMs();
    this.drop(key);
    if (this.entries.size >= this.maxEntries) this.evict(now);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
  }

  /** Primero lo caducado; si no basta, lo más viejo (orden de inserción). */
  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.drop(key);
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxEntries) break;
      this.drop(key);
    }
  }

  private drop(key: string): void {
    // eslint-disable-next-line no-restricted-syntax -- Map en memoria de la caché, no un dato de negocio.
    this.entries.delete(key);
  }
}
