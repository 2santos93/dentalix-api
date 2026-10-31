import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { Payer } from '../../domain/entities/payer.entity';
import {
  type LegacyStoredPayerType,
  payerTypeFromStored,
  storedPayerType,
} from '../../domain/legacy-payer-type';
import {
  CreatePayerRepoInput,
  PayerRepository,
  RetirePayerResult,
  UpdatePayerRepoInput,
} from '../../domain/ports/payer-repository.port';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../../audit/domain/config-audit';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import { payerSnapshot } from '../../domain/payer-audit';

export type PrismaPayer = Prisma.PayerGetPayload<Record<string, never>>;

/**
 * DX-326 fase 1: la fila guarda el código anterior (o el genérico) y el
 * dominio solo ve el tipo genérico.
 */
export function mapToEntity(row: PrismaPayer): Payer {
  return {
    id: row.id,
    name: row.name,
    type: payerTypeFromStored(row.type),
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const DUPLICATE_PAYER_MESSAGE = 'Ya existe un pagador con ese nombre.';

/**
 * El único UNIQUE que una escritura de pagadores puede violar es
 * (tenantId, name) entre los vivos: es la red de la carrera que el caso de uso
 * (que compara sin mayúsculas ni tildes) no puede cerrar solo.
 */
function rethrowDuplicateName(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw new ConflictException(DUPLICATE_PAYER_MESSAGE);
  }
  throw error;
}

@Injectable()
export class PrismaPayerRepository implements PayerRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** El INSERT necesita el tenant explícito (sin default desde la GUC). */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  list(params: { includeInactive: boolean }): Promise<Payer[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.payer.findMany({
        where: {
          deletedAt: null,
          ...(params.includeInactive ? {} : { active: true }),
        },
      });
      // El orden de la BD depende del collation; el catálogo se ordena en `es`.
      return rows
        .map(mapToEntity)
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    });
  }

  findById(id: string): Promise<Payer | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.payer.findFirst({ where: { id, deletedAt: null } });
      return row ? mapToEntity(row) : null;
    });
  }

  findByNormalizedName(
    nameKey: string,
    excludeId?: string,
  ): Promise<Payer | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // RLS acota a la clínica. `dx_search_normalize` es la misma regla que
      // `payerNameKey`, así que la comparación coincide con la del índice.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "payers"
        WHERE "deletedAt" IS NULL
          AND public.dx_search_normalize("name") = ${nameKey}
          AND (${excludeId ?? null}::uuid IS NULL OR id <> ${excludeId ?? null}::uuid)
        LIMIT 1`;
      if (rows.length === 0) return null;
      const row = await tx.payer.findFirst({
        where: { id: rows[0].id, deletedAt: null },
      });
      return row ? mapToEntity(row) : null;
    });
  }

  async create(
    input: CreatePayerRepoInput,
    audit: AuditRequestContext,
  ): Promise<Payer> {
    const tenantId = this.requireTenantId();
    return this.prisma
      .runWithTenant(async (tx) => {
        const row = await tx.payer.create({
          // Fase 1 (R5): se guarda el código anterior del tipo genérico.
          data: {
            tenantId,
            name: input.name,
            type: storedPayerType(input.type),
            active: input.active,
            createdById: input.createdById,
            updatedById: input.createdById,
          } satisfies Prisma.PayerUncheckedCreateInput & {
            type?: LegacyStoredPayerType;
          },
        });
        const created = mapToEntity(row);
        await writeAuditEvent(
          tx,
          configAuditEvent(audit, {
            action: 'CREATE',
            resourceType: 'PAYER',
            resourceId: created.id,
            reason: 'PAYER_CREATED',
            after: payerSnapshot(created),
          }),
        );
        return created;
      })
      .catch(rethrowDuplicateName);
  }

  /**
   * Por `id` bajo RLS. `null` si el pagador desapareció entre la lectura del
   * caso de uso y esta escritura (P2025).
   */
  async update(
    id: string,
    patch: UpdatePayerRepoInput,
    audit: AuditRequestContext,
  ): Promise<Payer | null> {
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const current = await tx.payer.findFirst({
          where: { id, deletedAt: null },
        });
        const row = await tx.payer.update({
          where: { id },
          data: {
            name: patch.name,
            type:
              patch.type === undefined
                ? undefined
                : storedPayerType(patch.type),
            active: patch.active,
            updatedById: patch.updatedById,
          } satisfies Prisma.PayerUpdateInput & {
            type?: LegacyStoredPayerType;
          },
        });
        const updated = mapToEntity(row);
        const event =
          current &&
          configAuditEvent(audit, {
            action: 'UPDATE',
            resourceType: 'PAYER',
            resourceId: id,
            reason: 'PAYER_UPDATED',
            before: payerSnapshot(mapToEntity(current)),
            after: payerSnapshot(updated),
          });
        if (event) await writeAuditEvent(tx, event);
        return updated;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        return null;
      }
      return rethrowDuplicateName(error);
    }
  }

  /**
   * Candado de fila sobre el pagador (`FOR UPDATE`) antes de contar: el alta o
   * cambio de cobertura (o el de un convenio) lo relee con `FOR SHARE` dentro de su transacción, así
   * que uno de los dos espera al otro y ve su resultado.
   */
  retire(id: string, audit: AuditRequestContext): Promise<RetirePayerResult> {
    return this.prisma.runWithTenant(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "payers"
        WHERE id = ${id}::uuid AND "deletedAt" IS NULL
        FOR UPDATE`;
      if (locked.length === 0) return 'NOT_FOUND';
      // Coberturas de pacientes y convenios vivos de la clínica (DX-105): con
      // cualquiera de los dos se desactiva en lugar de retirar.
      const [coverages, agreements] = await Promise.all([
        tx.patientCoverage.count({ where: { payerId: id, deletedAt: null } }),
        tx.agreement.count({ where: { payerId: id, deletedAt: null } }),
      ]);
      if (coverages > 0 || agreements > 0) return 'IN_USE';
      const before = await tx.payer.findUniqueOrThrow({ where: { id } });
      await tx.payer.update({
        where: { id },
        data: {
          active: false,
          deletedAt: new Date(),
          updatedById: audit.actor.userId,
        },
      });
      await writeAuditEvent(
        tx,
        configAuditEvent(audit, {
          action: 'DELETE',
          resourceType: 'PAYER',
          resourceId: id,
          reason: 'PAYER_DELETED',
          before: payerSnapshot(mapToEntity(before)),
        }),
      );
      return 'RETIRED';
    });
  }
}
