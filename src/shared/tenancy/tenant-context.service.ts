import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

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
}

@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<TenantStore>();

  run<T>(tenantId: string, fn: () => T): T;
  run<T>(tenantId: string, locationId: string | undefined, fn: () => T): T;
  run<T>(
    tenantId: string,
    locationIdOrFn: string | undefined | (() => T),
    maybeFn?: () => T,
  ): T {
    const fn = typeof locationIdOrFn === 'function' ? locationIdOrFn : maybeFn!;
    const locationId =
      typeof locationIdOrFn === 'function' ? undefined : locationIdOrFn;
    return this.als.run({ tenantId, locationId }, fn);
  }

  getTenantId(): string | undefined {
    return this.als.getStore()?.tenantId;
  }

  /** Sede activa, o `undefined` si el request pidió la vista consolidada. */
  getLocationId(): string | undefined {
    return this.als.getStore()?.locationId;
  }
}
