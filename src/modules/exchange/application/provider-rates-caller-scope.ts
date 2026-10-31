import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * SEC-058: marca lo que corre dentro del barrido de reintentos de los abonos
 * sin tasa (DX-380), para que sus llamadas al proveedor gasten del cupo
 * reservado (`SWEEP`) y no del de las peticiones de la clínica. Es un ámbito
 * async aparte del tenant: una petición HTTP nunca corre dentro de él.
 */
@Injectable()
export class ProviderRatesCallerScope {
  private readonly als = new AsyncLocalStorage<'SWEEP'>();

  asSweep<T>(fn: () => T): T {
    return this.als.run('SWEEP', fn);
  }

  isSweep(): boolean {
    return this.als.getStore() === 'SWEEP';
  }
}
