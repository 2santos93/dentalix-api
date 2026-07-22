import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { TenantContextService } from '../tenancy/tenant-context.service';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(private readonly tenantContext: TenantContextService) {
    super();
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
   */
  async runWithTenant<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>;
  async runWithTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>;
  async runWithTenant<T>(
    tenantIdOrFn: string | ((tx: Prisma.TransactionClient) => Promise<T>),
    maybeFn?: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    let tenantId: string;
    let fn: (tx: Prisma.TransactionClient) => Promise<T>;

    if (typeof tenantIdOrFn === 'function') {
      const contextTenantId = this.tenantContext.getTenantId();
      if (!contextTenantId) {
        throw new Error('No tenant in context');
      }
      tenantId = contextTenantId;
      fn = tenantIdOrFn;
    } else {
      tenantId = tenantIdOrFn;
      // El overload público garantiza que `maybeFn` viene presente en esta rama.
      fn = maybeFn as (tx: Prisma.TransactionClient) => Promise<T>;
    }

    return this.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      return fn(tx);
    });
  }
}
