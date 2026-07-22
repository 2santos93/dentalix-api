import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

interface TenantStore {
  tenantId: string;
}

@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<TenantStore>();

  run<T>(tenantId: string, fn: () => T): T {
    return this.als.run({ tenantId }, fn);
  }

  /**
   * Fija el tenant para el contexto async ACTUAL (y sus descendientes) sin callback.
   * Es lo que permite que un Guard establezca el contexto y que el handler posterior
   * lo vea vía getTenantId(). `run()` se sigue usando para scopes acotados (tests, jobs).
   */
  enterWith(tenantId: string): void {
    this.als.enterWith({ tenantId });
  }

  getTenantId(): string | undefined {
    return this.als.getStore()?.tenantId;
  }
}
