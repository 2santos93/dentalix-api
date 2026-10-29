import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { Agreement } from '../../domain/entities/agreement.entity';
import { payerTypeFromStored } from '../../../payers/domain/legacy-payer-type';
import {
  AgreementRepository,
  CreateAgreementRepoInput,
  RetireAgreementResult,
  UpdateAgreementRepoInput,
} from '../../domain/ports/agreement-repository.port';
import {
  AGREEMENT_DUPLICATE_MESSAGE,
  AGREEMENT_LOCATION_NOT_FOUND_MESSAGE,
  AGREEMENT_PAYER_INACTIVE_MESSAGE,
  AGREEMENT_PAYER_NOT_FOUND_MESSAGE,
  AGREEMENT_PRICE_LIST_INACTIVE_MESSAGE,
  AGREEMENT_PRICE_LIST_NOT_FOUND_MESSAGE,
} from '../../domain/agreement-rules';

const INCLUDE = {
  payer: { select: { id: true, name: true, type: true } },
  priceList: { select: { id: true, name: true, currency: true } },
  // Solo las asignaciones vivas: el historial retirado no cuenta.
  _count: { select: { assignments: { where: { deletedAt: null } } } },
} satisfies Prisma.AgreementInclude;

export type PrismaAgreement = Prisma.AgreementGetPayload<{
  include: typeof INCLUDE;
}>;

/** `Date` de una columna `@db.Date` (UTC medianoche) a `YYYY-MM-DD`. */
function toDay(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

function fromDay(day: string | null | undefined): Date | null | undefined {
  if (day === undefined) return undefined;
  return day === null ? null : new Date(`${day}T00:00:00.000Z`);
}

/** `null` vacía la columna JSON (`DbNull`); `undefined` no la toca. */
function toJson(
  map: Record<string, number> | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (map === undefined) return undefined;
  return map === null ? Prisma.DbNull : map;
}

/** DX-326 fase 1: el pagador sale con su tipo genérico (R4). */
export function mapToEntity(row: PrismaAgreement): Agreement {
  return {
    id: row.id,
    name: row.name,
    payer: {
      id: row.payer.id,
      name: row.payer.name,
      type: payerTypeFromStored(row.payer.type),
    },
    kind: row.kind,
    percent: row.percent ? row.percent.toNumber() : null,
    percentByCategory: row.percentByCategory as unknown as Record<
      string,
      number
    > | null,
    priceList: row.priceList
      ? {
          id: row.priceList.id,
          name: row.priceList.name,
          currency: row.priceList.currency,
        }
      : null,
    locationId: row.locationId,
    validFrom: toDay(row.validFrom),
    validTo: toDay(row.validTo),
    active: row.active,
    assignedCount: row._count.assignments,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * El UNIQUE parcial del nombre entre los vivos es la red de la carrera que el
 * caso de uso (que compara sin mayúsculas ni tildes) no puede cerrar solo; la
 * FK compuesta a `locations` cubre la sede retirada entre la lectura y aquí.
 */
function rethrowAgreementConflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      throw new ConflictException(AGREEMENT_DUPLICATE_MESSAGE);
    }
    if (error.code === 'P2003') {
      throw new BadRequestException(AGREEMENT_LOCATION_NOT_FOUND_MESSAGE);
    }
  }
  throw error;
}

type Tx = Prisma.TransactionClient;

/**
 * Relee el pagador `FOR SHARE`: `Payer.retire` lo toma `FOR UPDATE` antes de
 * contar convenios vivos, así que uno de los dos espera al otro y ve su
 * resultado.
 */
async function lockUsablePayer(tx: Tx, payerId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ active: boolean }[]>`
    SELECT "active" FROM "payers"
    WHERE id = ${payerId}::uuid AND "deletedAt" IS NULL
    FOR SHARE`;
  if (rows.length === 0) {
    throw new BadRequestException(AGREEMENT_PAYER_NOT_FOUND_MESSAGE);
  }
  if (!rows[0].active) {
    throw new BadRequestException(AGREEMENT_PAYER_INACTIVE_MESSAGE);
  }
}

/** Lo mismo con la lista de precios: su `retire` cuenta convenios vivos. */
async function lockUsablePriceList(tx: Tx, priceListId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ active: boolean }[]>`
    SELECT "active" FROM "price_lists"
    WHERE id = ${priceListId}::uuid AND "deletedAt" IS NULL
    FOR SHARE`;
  if (rows.length === 0) {
    throw new BadRequestException(AGREEMENT_PRICE_LIST_NOT_FOUND_MESSAGE);
  }
  if (!rows[0].active) {
    throw new BadRequestException(AGREEMENT_PRICE_LIST_INACTIVE_MESSAGE);
  }
}

@Injectable()
export class PrismaAgreementRepository implements AgreementRepository {
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

  list(params: { includeInactive: boolean }): Promise<Agreement[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.agreement.findMany({
        where: {
          deletedAt: null,
          ...(params.includeInactive ? {} : { active: true }),
        },
        include: INCLUDE,
      });
      // El orden de la BD depende del collation; se ordena en `es`.
      return rows
        .map(mapToEntity)
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    });
  }

  findById(id: string): Promise<Agreement | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.agreement.findFirst({
        where: { id, deletedAt: null },
        include: INCLUDE,
      });
      return row ? mapToEntity(row) : null;
    });
  }

  findLiveById(id: string): Promise<Agreement | null> {
    return this.findById(id);
  }

  findByNormalizedName(
    nameKey: string,
    excludeId?: string,
  ): Promise<Agreement | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // RLS acota a la clínica. `dx_search_normalize` es la misma regla que
      // `agreementNameKey`, así que la comparación coincide con la del índice.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "agreements"
        WHERE "deletedAt" IS NULL
          AND public.dx_search_normalize("name") = ${nameKey}
          AND (${excludeId ?? null}::uuid IS NULL OR id <> ${excludeId ?? null}::uuid)
        LIMIT 1`;
      if (rows.length === 0) return null;
      const row = await tx.agreement.findFirst({
        where: { id: rows[0].id, deletedAt: null },
        include: INCLUDE,
      });
      return row ? mapToEntity(row) : null;
    });
  }

  async create(input: CreateAgreementRepoInput): Promise<Agreement> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma
      .runWithTenant(async (tx) => {
        await lockUsablePayer(tx, input.payerId);
        if (input.priceListId !== null) {
          await lockUsablePriceList(tx, input.priceListId);
        }
        return tx.agreement.create({
          data: {
            tenantId,
            name: input.name,
            payerId: input.payerId,
            kind: input.kind,
            percent: input.percent,
            percentByCategory: toJson(input.percentByCategory),
            priceListId: input.priceListId,
            locationId: input.locationId,
            validFrom: fromDay(input.validFrom),
            validTo: fromDay(input.validTo),
            active: input.active,
            createdById: input.createdById,
            updatedById: input.createdById,
          },
          include: INCLUDE,
        });
      })
      .catch(rethrowAgreementConflict);
    return mapToEntity(row);
  }

  /**
   * Por `id` bajo RLS. `null` si el convenio desapareció entre la lectura del
   * caso de uso y esta escritura (P2025). Pagador y lista nuevos se bloquean
   * `FOR SHARE` antes de escribir.
   */
  async update(
    id: string,
    patch: UpdateAgreementRepoInput,
  ): Promise<Agreement | null> {
    try {
      const row = await this.prisma.runWithTenant(async (tx) => {
        if (patch.payerId !== undefined) {
          await lockUsablePayer(tx, patch.payerId);
        }
        if (patch.priceListId) {
          await lockUsablePriceList(tx, patch.priceListId);
        }
        return tx.agreement.update({
          // deletedAt: null → P2025 si un DELETE se coló: 404, no se reescribe.
          where: { id, deletedAt: null },
          data: {
            name: patch.name,
            payerId: patch.payerId,
            kind: patch.kind,
            percent: patch.percent,
            percentByCategory: toJson(patch.percentByCategory),
            priceListId: patch.priceListId,
            locationId: patch.locationId,
            validFrom: fromDay(patch.validFrom),
            validTo: fromDay(patch.validTo),
            active: patch.active,
            updatedById: patch.updatedById,
          },
          include: INCLUDE,
        });
      });
      return mapToEntity(row);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        return null;
      }
      return rethrowAgreementConflict(error);
    }
  }

  /**
   * Candado de fila sobre el convenio (`FOR UPDATE`) antes de contar: quien le
   * asigna un paciente lo relee con `FOR SHARE` en su transacción, así que uno
   * de los dos espera al otro y ve su resultado.
   */
  retire(id: string, updatedById?: string): Promise<RetireAgreementResult> {
    return this.prisma.runWithTenant(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "agreements"
        WHERE id = ${id}::uuid AND "deletedAt" IS NULL
        FOR UPDATE`;
      if (locked.length === 0) return 'NOT_FOUND';
      const inUse = await tx.patientAgreement.count({
        where: { agreementId: id, deletedAt: null },
      });
      if (inUse > 0) return 'IN_USE';
      await tx.agreement.update({
        where: { id },
        data: { active: false, deletedAt: new Date(), updatedById },
      });
      return 'RETIRED';
    });
  }
}
