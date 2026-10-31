import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { guardHardDeletes } from './no-hard-delete';
import { transactionConfigFor } from './transaction-config';

export interface RunWithTenantOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /**
   * Tope de la transacción interactiva en ms (por defecto
   * `TENANT_TX_TIMEOUT_MS`, 5000; DX-431). Solo para escrituras por lotes
   * acotadas (DX-107: dry-run de 10.000 filas y deshacer un lote), nunca para
   * esperar a un usuario.
   */
  timeout?: number;
  /**
   * Espera máxima por una conexión del pool, en ms (por defecto
   * `TENANT_TX_MAX_WAIT_MS`, 2000).
   */
  maxWait?: number;
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  /**
   * DX-431: `timeout`/`maxWait` de TODA transacción interactiva salen del
   * entorno (`TENANT_TX_TIMEOUT_MS`, `TENANT_TX_MAX_WAIT_MS`; ver
   * transaction-config.ts). Sin ConfigService (scripts e int-specs que crean
   * el servicio a mano), de `process.env`.
   */
  constructor(
    private readonly tenantContext: TenantContextService,
    @Optional() config?: ConfigService,
  ) {
    const tx = transactionConfigFor(
      config && { get: (key: string) => config.get<string>(key) },
    );
    super({
      transactionOptions: { timeout: tx.timeoutMs, maxWait: tx.maxWaitMs },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Ejecuta `fn` dentro de una transacción con `app.current_tenant` fijado a nivel
   * de transacción (SET LOCAL vía set_config(..., true)). Las policies RLS filtran
   * físicamente por ese tenant. El uso de set_config parametrizado evita inyección.
   *
   * Dos formas de invocación:
   * - `runWithTenant(tenantId, fn)`: tenant explícito (usado en fixtures/tests o
   *   cuando aún no hay contexto async establecido).
   * - `runWithTenant(fn)`: resuelve el tenant desde `TenantContextService`
   *   (`AsyncLocalStorage`), que es lo que un guard/handler ya dejó fijado para el
   *   request actual. Cierra el footgun de Fase 0A: los repositorios ya no tienen
   *   que pasar el tenant a mano en cada llamada. Lanza si no hay tenant en contexto.
   *
   * `options.isolationLevel` (opcional, ambas formas): sin él, el nivel por
   * defecto de Postgres (READ COMMITTED), que es lo que quiere casi todo. Una
   * lectura que hace VARIAS consultas y necesita que todas vean la MISMA foto
   * (p. ej. la caja: página + conteo + agregado) pide `RepeatableRead`; en READ
   * COMMITTED cada sentencia ve su propia foto y un abono registrado entre dos
   * de ellas dejaría totales que no casan con las filas.
   */
  async runWithTenant<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: RunWithTenantOptions,
  ): Promise<T>;
  async runWithTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: RunWithTenantOptions,
  ): Promise<T>;
  async runWithTenant<T>(
    tenantIdOrFn: string | ((tx: Prisma.TransactionClient) => Promise<T>),
    fnOrOptions?:
      ((tx: Prisma.TransactionClient) => Promise<T>) | RunWithTenantOptions,
    maybeOptions?: RunWithTenantOptions,
  ): Promise<T> {
    let tenantId: string;
    let fn: (tx: Prisma.TransactionClient) => Promise<T>;
    let options: RunWithTenantOptions | undefined;

    if (typeof tenantIdOrFn === 'function') {
      const contextTenantId = this.tenantContext.getTenantId();
      if (!contextTenantId) {
        throw new Error('No tenant in context');
      }
      tenantId = contextTenantId;
      fn = tenantIdOrFn;
      options = fnOrOptions as RunWithTenantOptions | undefined;
    } else {
      tenantId = tenantIdOrFn;
      // El overload público garantiza que la función viene presente en esta rama.
      fn = fnOrOptions as (tx: Prisma.TransactionClient) => Promise<T>;
      options = maybeOptions;
    }

    return this.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      // `guardHardDeletes`: dentro de una transacción de tenant no se borra
      // nada de verdad, se retira con `deletedAt`. Ver no-hard-delete.ts.
      return fn(guardHardDeletes(tx));
    }, options);
  }
}
