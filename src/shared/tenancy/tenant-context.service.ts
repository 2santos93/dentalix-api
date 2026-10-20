import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolveDefaultLocationId } from '../locations/default-location';
import {
  AllowedLocations,
  isLocationAllowed,
  locationNotAllowed,
  noActiveLocation,
} from './location-access';

interface TenantStore {
  tenantId: string;
  /**
   * Sede activa del request (cabecera `X-Location-Id`), ya validada contra el
   * tenant. `undefined` = vista CONSOLIDADA de toda la clínica, que es lo que
   * quiere el dueño en el dashboard y lo que ocurre por defecto (ningún
   * cliente que no mande la cabecera cambia de comportamiento).
   *
   * Vive en el MISMO store que el tenant a propósito: la sede solo tiene
   * sentido dentro de un tenant, y así comparten el ámbito async — no puede
   * quedar una sede colgada de otro request.
   */
  locationId?: string;
  /**
   * DX-089: sedes en las que puede trabajar el usuario (claim `loc` del
   * token). `undefined` = todas (sin restricción): es lo que pasan los demás
   * llamadores de `run()` (rutas públicas, jobs, opt-out de recordatorios).
   * `[]` = ninguna.
   */
  allowedLocationIds?: readonly string[];
}

/** Filtro Prisma por sede para las lecturas acotadas a sede. */
export interface LocationScope {
  locationId?: string | { in: string[] };
}

@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<TenantStore>();

  run<T>(tenantId: string, fn: () => T): T;
  run<T>(
    tenantId: string,
    locationId: string | undefined,
    fn: () => T,
    allowedLocationIds?: readonly string[],
  ): T;
  run<T>(
    tenantId: string,
    locationIdOrFn: string | undefined | (() => T),
    maybeFn?: () => T,
    allowedLocationIds?: readonly string[],
  ): T {
    const fn = typeof locationIdOrFn === 'function' ? locationIdOrFn : maybeFn!;
    const locationId =
      typeof locationIdOrFn === 'function' ? undefined : locationIdOrFn;
    return this.als.run({ tenantId, locationId, allowedLocationIds }, fn);
  }

  getTenantId(): string | undefined {
    return this.als.getStore()?.tenantId;
  }

  /** Sede activa, o `undefined` si el request pidió la vista consolidada. */
  getLocationId(): string | undefined {
    return this.als.getStore()?.locationId;
  }

  /** Sedes permitidas al usuario del request; `'ALL'` sin restricción. */
  getAllowedLocationIds(): AllowedLocations {
    return this.als.getStore()?.allowedLocationIds ?? 'ALL';
  }

  /** 403 `LOCATION_NOT_ALLOWED` si la sede no está entre las permitidas. */
  assertLocationAllowed(locationId: string): void {
    if (!isLocationAllowed(this.getAllowedLocationIds(), locationId)) {
      throw locationNotAllowed();
    }
  }

  /**
   * Filtro `where` de las lecturas por sede: la sede de la cabecera; sin
   * cabecera, las sedes permitidas (con `loc = []` el `in` vacío no devuelve
   * nada); sin restricción ni cabecera, ningún filtro (vista consolidada).
   */
  locationScope(): LocationScope {
    const ids = this.scopeLocationIds();
    if (ids === undefined) return {};
    const locationId = this.getLocationId();
    return locationId ? { locationId } : { locationId: { in: ids } };
  }

  /**
   * Las mismas sedes que `locationScope()` como lista, para las consultas que
   * no usan un `where` de Prisma. `undefined` = sin restricción.
   */
  scopeLocationIds(): string[] | undefined {
    const locationId = this.getLocationId();
    if (locationId) return [locationId];
    const allowed = this.getAllowedLocationIds();
    return allowed === 'ALL' ? undefined : [...allowed];
  }

  /**
   * Sede en la que se ESCRIBE una fila acotada a sede: la de la cabecera; sin
   * cabecera, la primera sede permitida y activa por antigüedad; sin
   * restricción, la sede por defecto de la clínica. Un miembro restringido
   * nunca cae en la sede por defecto: sin sede activa asignada → 403.
   * Corre dentro de la transacción tenant-scoped (`runWithTenant`).
   */
  async writeLocationId(tx: Prisma.TransactionClient): Promise<string> {
    const locationId = this.getLocationId();
    if (locationId) return locationId;
    const allowed = this.getAllowedLocationIds();
    if (allowed === 'ALL') return resolveDefaultLocationId(tx);
    if (allowed.length === 0) throw noActiveLocation();
    const first = await tx.location.findFirst({
      where: { id: { in: [...allowed] }, isActive: true, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!first) throw noActiveLocation();
    return first.id;
  }
}
